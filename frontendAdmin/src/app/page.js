"use client"
import Image from "next/image";
import AdminHome from "@/components/AdminHome";

import { Amplify } from "aws-amplify";

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
      userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID,
      region: process.env.NEXT_PUBLIC_AWS_REGION,
      allowGuestAccess: false,
    }
  },
  API: {
    REST: {
      MyApi: {
        endpoint: process.env.NEXT_PUBLIC_API_ENDPOINT,
      },
    },
  },
});

export default function Home() {
  return (
    <div>
      <AdminHome />
    </div>
    
  );
}