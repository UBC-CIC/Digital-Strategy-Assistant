import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { CfnIdentityPool } from "aws-cdk-lib/aws-cognito";

export const createRolesAndPolicies = (
  scope: Construct,
  id: string,
  identityPool: any,
  apiRestApiId: string,
  region: string,
  account: string
) => {
  const createPolicyStatement = (actions: string[], resources: string[]) => {
    return new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: actions,
      resources: resources,
    });
  };

  const adminRole = new iam.Role(scope,`${id}-AdminRole`, {
    assumedBy: new iam.FederatedPrincipal(
      "cognito-identity.amazonaws.com",
      {
        StringEquals: {
          "cognito-identity.amazonaws.com:aud": identityPool.ref,
        },
        "ForAnyValue:StringLike": {
          "cognito-identity.amazonaws.com:amr": "authenticated",
        },
      },
      "sts:AssumeRoleWithWebIdentity"
    ),
  });

  adminRole.attachInlinePolicy(
    new iam.Policy(scope, `${id}-AdminPolicy`, {
      statements: [
        createPolicyStatement(
          ["execute-api:Invoke"],
          [
            `arn:aws:execute-api:${region}:${account}:${apiRestApiId}/*/*/admin/*`,
            `arn:aws:execute-api:${region}:${account}:${apiRestApiId}/*/*/instructor/*`,
            `arn:aws:execute-api:${region}:${account}:${apiRestApiId}/*/*/user/*`,
          ]
        ),
      ],
    })
  );

  const unauthenticatedRole = new iam.Role(scope, `${id}-UnauthenticatedRole`, {
    assumedBy: new iam.FederatedPrincipal(
      "cognito-identity.amazonaws.com",
      {
        StringEquals: {
          "cognito-identity.amazonaws.com:aud": identityPool.ref,
        },
        "ForAnyValue:StringLike": {
          "cognito-identity.amazonaws.com:amr": "unauthenticated",
        },
      },
      "sts:AssumeRoleWithWebIdentity"
    ),
  });

  // Add permissions to access WebSocket API
  unauthenticatedRole.attachInlinePolicy(
    new iam.Policy(scope, `${id}-UnauthPolicy`, {
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "execute-api:ManageConnections",
            "execute-api:Invoke"
          ],
          resources: [
            `arn:aws:execute-api:${region}:${account}:${apiRestApiId}/*/*/user/*`,
            `arn:aws:execute-api:${region}:${account}:${apiRestApiId}/@connections/*`
          ],
        }),
      ],
    })
  );

  return { adminRole, unauthenticatedRole };
};