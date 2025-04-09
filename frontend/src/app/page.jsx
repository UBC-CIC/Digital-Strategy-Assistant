import Image from "next/image";
import { Amplify } from "aws-amplify";
import GeneralPublic from "@/components/home/GeneralPublic";
Amplify.configure({
  API: {
    REST: {
      MyApi: {
        endpoint: process.env.NEXT_PUBLIC_API_ENDPOINT
      },
    },
  },
  Auth: {
    Cognito: {
      region: process.env.NEXT_PUBLIC_AWS_REGION,
      userPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID,
      userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
      allowGuestAccess: true,
      identityPoolId: process.env.NEXT_PUBLIC_IDENTITY_POOL_ID, 
    },
  },
});

export default function Home() {
  return (
    <div>
      <GeneralPublic />
    </div>
    
  );
}
