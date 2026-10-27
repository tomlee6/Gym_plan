/**
 * AWS WAF v2 web ACL for the API load balancer (M-05, D-10).
 *
 * Rules, in evaluation order:
 *   1. Sign-in rate limit: POST /v1/auth/hub and /v1/auth/refresh,
 *      100 requests per 5 minutes per IP.
 *   2. Share links: /v1/share/..., 300 per 5 minutes per IP.
 *   3. Global: 2000 per 5 minutes per IP.
 *   4. AWS managed common rule set (with the 8 KB body limit relaxed to
 *      "count", because plan JSON is legitimately larger).
 *   5. AWS managed known bad inputs (Log4Shell and similar).
 *
 * Blocked requests get 429 from the rate rules and 403 from the managed rules.
 * Every rule reports CloudWatch metrics and sampled requests.
 */
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface ApiWafProps {
  name: string;
  loadBalancer: elbv2.IApplicationLoadBalancer;
}

/** WAF rate limits are counted over this window. */
const WINDOW_SECONDS = 300;

type Statement = wafv2.CfnWebACL.StatementProperty;

function pathStartsWith(prefix: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: 'STARTS_WITH',
      searchString: prefix,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

function methodIs(method: string): Statement {
  return {
    byteMatchStatement: {
      fieldToMatch: { method: {} },
      positionalConstraint: 'EXACTLY',
      searchString: method,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

function visibility(metricName: string): wafv2.CfnWebACL.VisibilityConfigProperty {
  return { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName };
}

const TOO_MANY_REQUESTS: wafv2.CfnWebACL.RuleActionProperty = {
  block: { customResponse: { responseCode: 429 } },
};

function rateRule(name: string, priority: number, limit: number, scopeDown?: Statement): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    action: TOO_MANY_REQUESTS,
    visibilityConfig: visibility(name),
    statement: {
      rateBasedStatement: {
        limit,
        evaluationWindowSec: WINDOW_SECONDS,
        aggregateKeyType: 'IP',
        scopeDownStatement: scopeDown,
      },
    },
  };
}

function managedRule(
  name: string,
  priority: number,
  ruleActionOverrides?: wafv2.CfnWebACL.RuleActionOverrideProperty[],
): wafv2.CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    visibilityConfig: visibility(name),
    statement: {
      managedRuleGroupStatement: { vendorName: 'AWS', name, ruleActionOverrides },
    },
  };
}

export class ApiWaf extends Construct {
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: ApiWafProps) {
    super(scope, id);

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: props.name,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(props.name),
      rules: [
        rateRule('signin-rate', 10, 100, {
          andStatement: {
            statements: [
              methodIs('POST'),
              { orStatement: { statements: [pathStartsWith('/v1/auth/hub'), pathStartsWith('/v1/auth/refresh')] } },
            ],
          },
        }),
        rateRule('share-rate', 20, 300, pathStartsWith('/v1/share/')),
        rateRule('global-rate', 30, 2000),
        managedRule('AWSManagedRulesCommonRuleSet', 40, [
          { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
        ]),
        managedRule('AWSManagedRulesKnownBadInputsRuleSet', 50),
      ],
    });

    new wafv2.CfnWebACLAssociation(this, 'Association', {
      resourceArn: props.loadBalancer.loadBalancerArn,
      webAclArn: this.webAcl.attrArn,
    });
  }
}
