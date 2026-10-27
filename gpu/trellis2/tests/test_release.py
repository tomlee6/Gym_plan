"""
Releasing a TRELLIS.2 image (N-05, release.py): what a push must change to
start the image pipeline, the golden test run as the environment's role,
and the approved digest committed into cdk.json.

Standard library only (and git, for the change check).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import release  # noqa: E402

ROOT = HERE.parent.parent
OLD = "111111111111.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:" + "a" * 64
NEW = "111111111111.dkr.ecr.ap-southeast-2.amazonaws.com/flexgym/trellis2@sha256:" + "b" * 64
HAS_GIT = shutil.which("git") is not None


class ImageInputs(unittest.TestCase):
    def test_the_files_the_image_is_built_from(self):
        inputs = release.image_inputs((HERE / "Dockerfile").read_text(encoding="utf-8"))
        for path in ["Dockerfile", "buildspec.yml", "requirements.lock", "worker.py", "measured.py", "bake.py", "pipeline.json", "weights.lock.json"]:
            self.assertIn(f"gpu/trellis2/{path}", inputs)
        # Not tests, the README, the golden reference, nor what comes from another build stage.
        self.assertFalse(any("/tests" in p or p.endswith(".md") or "/golden/" in p or "/opt/" in p for p in inputs), inputs)
        for path in inputs:
            self.assertTrue((ROOT / path).exists(), f"{path} exists")

    def test_reads_copies_over_several_lines_and_skips_other_stages(self):
        dockerfile = "FROM x AS build\nCOPY a.py \\\n     b.json /app/\nCOPY --from=build /opt/x /opt/x\nRUN echo 'COPY c.py /nowhere' \nCOPY --chown=1:1 d.py /app/\n"
        self.assertEqual(release.image_inputs(dockerfile)[2:], ["gpu/trellis2/a.py", "gpu/trellis2/b.json", "gpu/trellis2/d.py"])


@unittest.skipUnless(HAS_GIT, "needs git")
class Changed(unittest.TestCase):
    """A repository with the image's folder in it, pushed to step by step."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "Test")
        self.write("gpu/trellis2/Dockerfile", "FROM x\nCOPY worker.py /app/\n")
        self.write("gpu/trellis2/buildspec.yml", "version: 0.2\n")
        self.write("gpu/trellis2/worker.py", "print(1)\n")
        self.write("gpu/trellis2/README.md", "# Worker\n")
        self.write("gpu/trellis2/tests/test_worker.py", "\n")
        self.write("backend/app.js", "\n")
        self.first = self.commit("first")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text, encoding="utf-8")

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-q", "-m", message)
        return self.git("rev-parse", "HEAD")

    def check(self, old, new):
        return release.changed(old, new, root=self.root)

    def test_builds_when_what_goes_into_the_image_changes(self):
        for path in ["gpu/trellis2/worker.py", "gpu/trellis2/Dockerfile", "gpu/trellis2/buildspec.yml"]:
            before = self.git("rev-parse", "HEAD")
            self.write(path, (self.root / path).read_text(encoding="utf-8") + "# changed\n")
            after = self.commit(f"change {path}")
            build, why = self.check(before, after)
            self.assertTrue(build, path)
            self.assertIn(path, why)

    def test_does_not_build_for_a_readme_a_test_or_another_part_of_the_app(self):
        for path in ["gpu/trellis2/README.md", "gpu/trellis2/tests/test_worker.py", "backend/app.js"]:
            self.write(path, "changed\n")
        after = self.commit("no image change")
        build, why = self.check(self.first, after)
        self.assertFalse(build)
        self.assertIn("nothing the image is built from changed", why)

    def test_builds_for_a_new_branch_or_a_history_it_cannot_compare(self):
        for old in ["", "null", "0" * 40]:
            self.assertEqual(self.check(old, self.first), (True, "a new branch"), old)
        build, why = self.check("1234567890abcdef1234567890abcdef12345678", self.first)
        self.assertTrue(build)
        self.assertIn("not in the history", why)

    def test_the_command_says_build_or_not_by_its_exit(self):
        self.write("gpu/trellis2/README.md", "changed\n")
        after = self.commit("readme")
        original = release.HERE
        try:
            release.HERE = self.root / "gpu" / "trellis2"
            # main() looks in the repository it sits in: the one made here.
            changed = release.changed
            release.changed = lambda old, new: changed(old, new, root=self.root)
            self.assertEqual(release.main(["changed", "--old", self.first, "--new", after]), release.NO_BUILD)
            self.write("gpu/trellis2/worker.py", "print(2)\n")
            again = self.commit("worker")
            self.assertEqual(release.main(["changed", "--old", after, "--new", again]), release.BUILD)
        finally:
            release.HERE = original
            release.changed = changed


class Golden(unittest.TestCase):
    def test_runs_the_golden_test_as_the_environments_role(self):
        calls = {}

        class Sts:
            def assume_role(self, **kwargs):
                calls["assume"] = kwargs
                return {"Credentials": {"AccessKeyId": "k", "SecretAccessKey": "s", "SessionToken": "t"}}

        class Session:
            def __init__(self, credentials):
                calls["credentials"] = credentials

            def client(self, name):
                return f"{name} as the golden role"

        def run(env, image, *, batch, s3, run_id):
            calls["run"] = (env, image, batch, s3, run_id)
            return 0

        role = "arn:aws:iam::222222222222:role/flexgym-trellis2-golden-test"
        code = release.golden(NEW, "staging", role, "release-7", sts=Sts(), session_for=Session, run=run, s3_for=lambda client: client)
        self.assertEqual(code, 0)
        self.assertEqual(calls["assume"], {"RoleArn": role, "RoleSessionName": "golden-release-7", "DurationSeconds": 7200})
        self.assertEqual(calls["credentials"]["SessionToken"], "t")
        self.assertEqual(calls["run"], ("staging", NEW, "batch as the golden role", "s3 as the golden role", "release-7"))

    def test_a_failed_golden_test_fails_the_step(self):
        sts = type("Sts", (), {"assume_role": lambda self, **k: {"Credentials": {"AccessKeyId": "", "SecretAccessKey": "", "SessionToken": ""}}})()
        session = lambda c: type("S", (), {"client": lambda self, n: n})()  # noqa: E731
        self.assertEqual(release.golden(NEW, "staging", "arn", "r", sts=sts, session_for=session, run=lambda *a, **k: 1, s3_for=lambda c: c), 1)

    def test_refuses_an_image_not_named_by_digest(self):
        with self.assertRaises(SystemExit):
            release.golden(NEW.split("@")[0] + ":latest", "staging", "arn", "r", sts=object(), session_for=object(), run=object())


def cdk_json(**images) -> str:
    """The repository's cdk.json, with these environments' images."""
    text = (ROOT / "infra" / "cdk.json").read_text(encoding="utf-8")
    data = json.loads(text)
    for name, image in images.items():
        old = json.dumps(data["context"]["environments"][name]["trellis2Image"])
        # Only that environment's value: find it after its name.
        at = text.index(f'"{name}"', text.index('"environments"'))
        start = text.index('"trellis2Image"', at)
        end = text.index(old, start) + len(old)
        text = text[:start] + f'"trellis2Image": {json.dumps(image)}' + text[end:]
    return text


class Adopt(unittest.TestCase):
    def test_gives_the_image_to_every_environment_with_a_gpu_and_changes_nothing_else(self):
        before = cdk_json(staging=OLD, prod=OLD)
        after, moved = release.with_image(before, NEW)
        self.assertEqual(moved, ["staging", "prod"])
        environments = json.loads(after)["context"]["environments"]
        self.assertEqual((environments["staging"]["trellis2Image"], environments["prod"]["trellis2Image"]), (NEW, NEW))
        self.assertEqual(environments["dev"]["trellis2Image"], "", "no GPU environment is made where there was none")
        changed = [(a, b) for a, b in zip(before.splitlines(), after.splitlines()) if a != b]
        self.assertEqual(len(changed), 2, "only the two image lines, as written")
        self.assertEqual(len(before.splitlines()), len(after.splitlines()))

    def test_nothing_to_change_without_a_gpu_environment_or_when_already_in_use(self):
        self.assertEqual(release.with_image(cdk_json(), NEW)[1], [])
        self.assertEqual(release.with_image(cdk_json(staging=NEW, prod=NEW), NEW)[1], [])

    def fake(self, files, *, outdated=0):
        test = self

        class Outdated(Exception):
            pass

        Outdated.__name__ = "ParentCommitIdOutdatedException"

        class CodeCommit:
            def __init__(self):
                self.heads = ["c1"]
                self.puts = []
                self.outdated = outdated

            def get_branch(self, repositoryName, branchName):
                test.assertEqual((repositoryName, branchName), ("gym_floor_plan", "main"))
                return {"branch": {"commitId": self.heads[-1]}}

            def get_file(self, repositoryName, commitSpecifier, filePath):
                test.assertEqual(filePath, "infra/cdk.json")
                return {"fileContent": files[commitSpecifier].encode("utf-8")}

            def put_file(self, **kwargs):
                if self.outdated:
                    self.outdated -= 1
                    self.heads.append(f"c{len(self.heads) + 1}")
                    files[self.heads[-1]] = files[self.heads[-2]]
                    raise Outdated("the branch moved")
                self.puts.append(kwargs)
                return {"commitId": "c-new"}

        return CodeCommit()

    def test_commits_the_digest_onto_the_branch_as_it_stands(self):
        files = {"c1": cdk_json(staging=OLD, prod=OLD)}
        codecommit = self.fake(files)
        self.assertEqual(release.adopt(NEW, codecommit=codecommit, repository="gym_floor_plan", branch="main"), "c-new")
        [put] = codecommit.puts
        self.assertEqual((put["branchName"], put["filePath"], put["parentCommitId"]), ("main", "infra/cdk.json", "c1"))
        self.assertEqual(release.with_image(files["c1"], NEW)[0].encode("utf-8"), put["fileContent"])
        self.assertIn("staging, prod", put["commitMessage"])
        self.assertIn("sha256:" + "b" * 64, put["commitMessage"])

    def test_reads_the_branch_again_when_it_moved(self):
        codecommit = self.fake({"c1": cdk_json(staging=OLD)}, outdated=1)
        self.assertEqual(release.adopt(NEW, codecommit=codecommit, repository="gym_floor_plan", branch="main"), "c-new")
        self.assertEqual(codecommit.puts[0]["parentCommitId"], "c2")

    def test_commits_nothing_when_there_is_nothing_to_change(self):
        codecommit = self.fake({"c1": cdk_json(staging=NEW)})
        self.assertIsNone(release.adopt(NEW, codecommit=codecommit, repository="gym_floor_plan", branch="main"))
        self.assertEqual(codecommit.puts, [])

    def test_refuses_an_image_from_anywhere_else_or_by_tag(self):
        for image in [NEW.split("@")[0] + ":v1", NEW.replace("ap-southeast-2", "us-east-1"), NEW.replace("flexgym/trellis2", "other/x")]:
            with self.assertRaises(SystemExit, msg=image):
                release.adopt(image, codecommit=None, repository="r", branch="main")


if __name__ == "__main__":
    unittest.main()
