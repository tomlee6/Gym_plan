"""
Releasing a TRELLIS.2 worker image (task N-05). The steps the image pipeline
(infra/lib/trellis2-image.ts) runs round the image build:

    python release.py changed --old <commit> --new <commit>
        Whether a push to main changed anything the image is built from:
        the Dockerfile, the build's own buildspec, and every file the
        Dockerfile copies in. Exits 0 if so (build it), 10 if not. A README
        or a test alone does not start hours of compiling.

    python release.py golden --image <...@sha256:...> --env staging --role-arn <arn> --run-id <id>
        The golden test (golden.py, L-14) on the new image, on that
        environment's GPUs, as the role the environment keeps for it.
        Exits 0 when it passes.

    python release.py adopt --image <...@sha256:...> --repository <name> --branch main
        After a person approved it: the digest written into infra/cdk.json
        for every environment that has a GPU environment, and committed to
        the branch, which the release then deploys (staging, then prod on
        its own approval). An environment without one is left alone: the
        first image is set up by hand (docs/runbooks/trellis2-worker.md).
"""
from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# This folder, from the repository's root.
FOLDER = "gpu/trellis2"
BUILD = 0
NO_BUILD = 10
CDK_JSON = "infra/cdk.json"
IMAGE = re.compile(r"^\d{12}\.dkr\.ecr\.ap-southeast-2\.amazonaws\.com/flexgym/trellis2@sha256:[0-9a-f]{64}$")
# The golden job can wait for a GPU host, pull the image, fetch the weights and generate: two hours is ample.
SESSION_SECONDS = 2 * 60 * 60


# --------------------------------------------------------------------------
# Changed?


def image_inputs(dockerfile: str) -> list[str]:
    """What the image is built from, as paths from the repository's root: the Dockerfile, the buildspec, what it copies in."""
    joined = re.sub(r"\\\r?\n", " ", dockerfile)
    sources = set()
    for line in joined.splitlines():
        if not re.match(r"\s*COPY\s", line, re.IGNORECASE):
            continue
        words = shlex.split(line.strip())
        if any(w.startswith("--from") for w in words):
            continue
        paths = [w for w in words[1:] if not w.startswith("--")]
        sources.update(paths[:-1])  # the last is where it goes
    return [f"{FOLDER}/Dockerfile", f"{FOLDER}/buildspec.yml", *(f"{FOLDER}/{s}" for s in sorted(sources))]


def changed(old: str, new: str, *, root: Path = HERE.parent.parent, run=subprocess.run) -> tuple[bool, str]:
    """Whether to build, and why."""
    git = lambda *args: run(["git", *args], cwd=root, capture_output=True, text=True)  # noqa: E731
    # No old commit (EventBridge passes none, or null, when a branch is created): build.
    if not old or old == "null" or set(old) == {"0"}:
        return True, "a new branch"
    if git("cat-file", "-e", f"{old}^{{commit}}").returncode != 0:
        return True, f"{old} is not in the history (rewritten?)"
    inputs = image_inputs((root / FOLDER / "Dockerfile").read_text(encoding="utf-8"))
    diff = git("diff", "--name-only", old, new, "--", *inputs)
    if diff.returncode != 0:
        raise RuntimeError(f"git diff failed: {diff.stderr.strip()}")
    files = [f for f in diff.stdout.splitlines() if f]
    if files:
        return True, "changed: " + ", ".join(files)
    return False, f"nothing the image is built from changed between {old[:12]} and {new[:12]}"


# --------------------------------------------------------------------------
# The golden test, in the environment's account.


def golden(image: str, env: str, role_arn: str, run_id: str, *, sts=None, session_for=None, run=None, s3_for=None) -> int:
    """Runs golden.run as `role_arn`; returns its exit code."""
    if not IMAGE.match(image):
        raise SystemExit(f"Not an approved form of image name (flexgym/trellis2 by digest in ECR in Sydney): {image}")
    if sts is None or session_for is None:
        import boto3  # noqa: PLC0415

        sts = sts or boto3.client("sts")
        session_for = session_for or (lambda c: boto3.Session(aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"], aws_session_token=c["SessionToken"]))
    if run is None:
        import golden as golden_test  # noqa: PLC0415

        run = golden_test.run
    if s3_for is None:
        from worker import S3 as s3_for  # noqa: PLC0415, N813

    credentials = sts.assume_role(RoleArn=role_arn, RoleSessionName=f"golden-{run_id}"[:64], DurationSeconds=SESSION_SECONDS)["Credentials"]
    session = session_for(credentials)
    return run(env, image, batch=session.client("batch"), s3=s3_for(session.client("s3")), run_id=run_id)


# --------------------------------------------------------------------------
# Adopting an approved image.


def with_image(text: str, image: str) -> tuple[str, list[str]]:
    """cdk.json with `image` for every environment that has a GPU environment, as written (only those values change)."""
    environments = json.loads(text)["context"]["environments"]
    using = [name for name, env in environments.items() if env.get("trellis2Image")]
    if not using:
        return text, []
    out = re.sub(r'("trellis2Image"\s*:\s*")([^"]+)(")', lambda m: m.group(1) + image + m.group(3), text)
    after = json.loads(out)["context"]["environments"]
    assert all(after[name]["trellis2Image"] == image for name in using), "cdk.json not as expected"
    assert all(not after[name]["trellis2Image"] for name in after if name not in using), "an environment without a GPU was given one"
    moved = [name for name in using if environments[name]["trellis2Image"] != image]
    return out, moved


def adopt(image: str, *, codecommit, repository: str, branch: str, path: str = CDK_JSON, tries: int = 3) -> str | None:
    """Commits the image into cdk.json on the branch; returns the commit, or None when there was nothing to change."""
    if not IMAGE.match(image):
        raise SystemExit(f"Not an approved form of image name (flexgym/trellis2 by digest in ECR in Sydney): {image}")
    for attempt in range(tries):
        head = codecommit.get_branch(repositoryName=repository, branchName=branch)["branch"]["commitId"]
        text = codecommit.get_file(repositoryName=repository, commitSpecifier=head, filePath=path)["fileContent"].decode("utf-8")
        updated, moved = with_image(text, image)
        if not moved:
            print("Nothing to change: no environment has a GPU environment yet, or every one already uses this image.")
            return None
        try:
            commit = codecommit.put_file(
                repositoryName=repository,
                branchName=branch,
                filePath=path,
                fileContent=updated.encode("utf-8"),
                parentCommitId=head,
                commitMessage=f"TRELLIS.2 worker image for {', '.join(moved)}: {image.split('@')[1]}\n\nGolden test passed and approved in the image pipeline (N-05).",
                name="TRELLIS.2 image pipeline",
            )["commitId"]
        except Exception as e:  # noqa: BLE001
            # The branch moved since it was read: read it again.
            if type(e).__name__ in ("ParentCommitIdOutdatedException",) and attempt < tries - 1:
                continue
            raise
        print(f"Committed {commit}: {', '.join(moved)} {'use' if len(moved) > 1 else 'uses'} {image} from now on.")
        return commit
    return None


# --------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Steps of the TRELLIS.2 image pipeline (N-05).")
    steps = parser.add_subparsers(dest="step", required=True)
    c = steps.add_parser("changed", help="did a push change what the image is built from?")
    c.add_argument("--old", default="")
    c.add_argument("--new", required=True)
    g = steps.add_parser("golden", help="the golden test, as the environment's golden-test role")
    g.add_argument("--image", required=True)
    g.add_argument("--env", required=True, choices=["dev", "staging", "prod"])
    g.add_argument("--role-arn", required=True)
    g.add_argument("--run-id", required=True)
    a = steps.add_parser("adopt", help="commit an approved image into cdk.json")
    a.add_argument("--image", required=True)
    a.add_argument("--repository", required=True)
    a.add_argument("--branch", required=True)
    args = parser.parse_args(argv)

    if args.step == "changed":
        build, why = changed(args.old, args.new)
        print(("Build: " if build else "No build: ") + why)
        return BUILD if build else NO_BUILD
    if args.step == "golden":
        return golden(args.image, args.env, args.role_arn, args.run_id)
    import boto3  # noqa: PLC0415

    adopt(args.image, codecommit=boto3.client("codecommit"), repository=args.repository, branch=args.branch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
