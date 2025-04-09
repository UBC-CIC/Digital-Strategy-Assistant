"use client";
import React, { useState } from "react";
import Header from "../Header";
import Image from "next/image";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  signIn,
  signUp,
  signOut,
  confirmSignIn,
  confirmSignUp,
  resendSignUpCode,
  resetPassword,
  confirmResetPassword,
  fetchAuthSession,
} from "aws-amplify/auth";

import { toast, ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const SignIn = ({
  email,
  setEmail,
  password,
  setPassword,
  setAuthState,
  loading,
  setLoading,
}) => {
  const handleSubmit = async (e) => {
    e.preventDefault();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      toast.error("Please enter a valid email address.", {
        position: "top-center",
        autoClose: 3000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
        theme: "colored",
      });
      return;
    }

    try {
      await signIn({
        username: email.toLowerCase(),
        password: password,
      });
      const { tokens } = await fetchAuthSession();
      const userGroup = tokens?.accessToken?.payload["cognito:groups"] || [];
      if (!userGroup.includes("admin")) {
        toast.error(
          `Error: You do not have administrative access. Please contact your system administrator to request admin privileges.`,
          {
            position: "top-center",
            autoClose: 3000,
            hideProgressBar: false,
            closeOnClick: true,
            pauseOnHover: true,
            draggable: true,
            progress: undefined,
            theme: "colored",
          }
        );
        await signOut();
      }
      else {
        window.location.reload();
      }
    } catch (error) {
      console.error("Sign in error:", error);
      toast.error(`Error: ${error}`, {
        position: "top-center",
        autoClose: 3000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
        theme: "colored",
      });
      await signOut();
    }
  };

  return (
    <div className="w-full max-w-md">
      <h2 className="text-2xl mb-6">Sign in</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          id="email"
          placeholder="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1"
          maxLength={50}
        />
        <Input
          type="password"
          id="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1"
          maxLength={50}
        />
        <p className="text-sm text-gray-600">
          <a
            onClick={() => setAuthState("forgotPassword")}
            className="text-blue-600 hover:underline cursor-pointer"
          >
            Forgot Password
          </a>
        </p>
        <Button
          type="submit"
          className="w-full bg-blue-900 hover:bg-blue-800 text-md"
        >
          SIGN IN
        </Button>
      </form>
      <div className="mt-2">
         <p className="text-sm text-gray-600">
           Don't have an account?{" "}
           <a
             onClick={() => setAuthState("signup")}
             className="text-blue-600 hover:underline cursor-pointer"
           >
             Sign up
           </a>
         </p>
       </div>
    </div>
  );
};

export default SignIn;
