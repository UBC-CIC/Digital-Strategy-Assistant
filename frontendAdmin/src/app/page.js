"use client"
import Image from "next/image";
import AdminHome from "@/components/AdminHome";
import { cognitoUserPoolsTokenProvider } from "aws-amplify/auth/cognito";
import { Amplify } from "aws-amplify";

Amplify.configure({
    Auth: {
      Cognito: {
        region: process.env.NEXT_PUBLIC_AWS_REGION,
        userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
        userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID,
        identityPoolId: process.env.NEXT_PUBLIC_IDENTITY_POOL_ID,  // Added for guest credentials
        allowGuestAccess: true,
        loginWith: {
          username: true,
          email: true
        }
      }
    },

  API: {
    REST: {
      MyApi: {
        endpoint: process.env.NEXT_PUBLIC_API_ENDPOINT,
      },
    },
    GraphQL: {
      aws_appsync_graphqlEndpoint: process.env.NEXT_PUBLIC_APPSYNC_API_URL,
      aws_appsync_region: process.env.NEXT_PUBLIC_AWS_REGION,
      aws_appsync_authenticationType: "AWS_IAM",
    }
},
});

export default function Home() {
  return (
    <div>
      <AdminHome />
    </div>
    
  );
}