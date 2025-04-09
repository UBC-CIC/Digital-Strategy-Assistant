"use client"
import Image from "next/image";
import AdminHome from "@/components/AdminHome";
import { useEffect, useState } from "react";
import { Amplify } from "aws-amplify";

// Client-side only configuration
function AmplifyConfigWrapper() {
  const [isConfigured, setIsConfigured] = useState(false);
  
  useEffect(() => {
    // Only configure Amplify on the client side
    Amplify.configure({
      Auth: {
        region: process.env.NEXT_PUBLIC_AWS_REGION,
        userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
        userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID,
        identityPoolId: process.env.NEXT_PUBLIC_IDENTITY_POOL_ID,
      },
      API: {
        REST: {
          MyApi: {
            endpoint: process.env.NEXT_PUBLIC_API_ENDPOINT,
          },
        },
      },
      AppSync: {
        defaultAuthMode: "iam",
        apiKey: undefined,
        region: process.env.NEXT_PUBLIC_AWS_REGION,
        endpoint: process.env.NEXT_PUBLIC_APPSYNC_API_URL,
      }
    });
    
    setIsConfigured(true);
  }, []);

  if (!isConfigured) {
    return <div>Loading...</div>;
  }

  return <AdminHome />;
}

export default function Home() {
  return (
    <div>
      <AmplifyConfigWrapper />
    </div>
  );
}