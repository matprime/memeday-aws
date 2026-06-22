"use client";

import { useState } from "react";
import { X, Mail, Loader2 } from "lucide-react";
import { useAppStore } from "@/lib/store";

interface Props {
  onClose: () => void;
}

type Mode = "signin" | "signup" | "confirm" | "forgot" | "reset";

export function EmailAuthModal({ onClose }: Props) {
  const { setCognitoToken, addToast } = useAppStore();

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // Cognito username returned by signup — needed to confirm, since the email
  // alias only becomes usable after verification.
  const [pendingUsername, setPendingUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const post = async (path: string, body: Record<string, string>) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error ?? "Request failed") as Error & {
        needsConfirmation?: boolean;
        username?: string;
      };
      err.needsConfirmation = data.needsConfirmation;
      err.username = data.username;
      throw err;
    }
    return data;
  };

  const finishLogin = async (accessToken: string) => {
    setCognitoToken(accessToken, "email", email);
    // Ensure the user item exists with the EMAIL# lookup entry
    await fetch("/api/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ email }),
    });
    addToast("Signed in!", "success");
    onClose();
  };

  const handleSubmit = async () => {
    setLoading(true);
    try {
      if (mode === "signin") {
        const { accessToken } = await post("/api/auth/email/login", { email, password });
        await finishLogin(accessToken);
      } else if (mode === "signup") {
        const { username } = await post("/api/auth/email/signup", { email, password });
        setPendingUsername(username);
        setMode("confirm");
        addToast("Verification code sent — check your email.", "success");
      } else if (mode === "forgot") {
        await post("/api/auth/email/forgot-password", { email });
        setMode("reset");
        addToast("Reset code sent — check your email.", "success");
      } else if (mode === "reset") {
        await post("/api/auth/email/reset-password", { email, code, newPassword });
        const { accessToken } = await post("/api/auth/email/login", { email, password: newPassword });
        await finishLogin(accessToken);
      } else {
        await post("/api/auth/email/confirm", { username: pendingUsername, code });
        const { accessToken } = await post("/api/auth/email/login", { email, password });
        await finishLogin(accessToken);
      }
    } catch (err) {
      const e = err as Error & { needsConfirmation?: boolean; username?: string };
      if (e.needsConfirmation && e.username) {
        setPendingUsername(e.username);
        setMode("confirm");
        addToast("Email not verified — we sent you a new code.", "error");
      } else {
        addToast(e.message, "error");
      }
    } finally {
      setLoading(false);
    }
  };

  const canSubmit =
    mode === "confirm"
      ? code.trim().length > 0
      : mode === "forgot"
      ? email.trim().length > 0
      : mode === "reset"
      ? code.trim().length > 0 && newPassword.length > 0
      : email.trim().length > 0 && password.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-2xl w-full max-w-sm animate-slide-up shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-bold text-white text-lg">
            {mode === "signin"
              ? "Sign in with Email"
              : mode === "signup"
              ? "Create Account"
              : mode === "forgot"
              ? "Reset Password"
              : mode === "reset"
              ? "Choose New Password"
              : "Verify Email"}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {mode === "confirm" ? (
            <div>
              <p className="text-sm text-gray-400 mb-3">
                We sent a verification code to <span className="text-white">{email}</span>.
              </p>
              <label className="text-xs text-gray-400 mb-1.5 block font-medium">Verification code</label>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white font-mono focus:outline-none focus:border-accent placeholder:text-gray-600"
              />
            </div>
          ) : mode === "forgot" ? (
            <div>
              <p className="text-sm text-gray-400 mb-3">
                Enter your email and we&apos;ll send a reset code.
              </p>
              <label className="text-xs text-gray-400 mb-1.5 block font-medium">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && canSubmit && !loading && handleSubmit()}
                placeholder="you@example.com"
                className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent placeholder:text-gray-600"
              />
            </div>
          ) : mode === "reset" ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">
                We sent a reset code to <span className="text-white">{email}</span>.
              </p>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block font-medium">Reset code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white font-mono focus:outline-none focus:border-accent placeholder:text-gray-600"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block font-medium">New password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canSubmit && !loading && handleSubmit()}
                  placeholder="••••••••"
                  className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent placeholder:text-gray-600"
                />
                <p className="text-xs text-gray-600 mt-1.5">
                  At least 8 characters with uppercase, lowercase, number, and symbol.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="text-xs text-gray-400 mb-1.5 block font-medium">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent placeholder:text-gray-600"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-gray-400 font-medium">Password</label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => setMode("forgot")}
                      className="text-xs text-accent-light hover:underline"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canSubmit && !loading && handleSubmit()}
                  placeholder="••••••••"
                  className="w-full bg-bg/60 border border-border rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-accent placeholder:text-gray-600"
                />
                {mode === "signup" && (
                  <p className="text-xs text-gray-600 mt-1.5">
                    At least 8 characters with uppercase, lowercase, number, and symbol.
                  </p>
                )}
              </div>
            </>
          )}

          {loading ? (
            <div className="w-full py-3 rounded-xl bg-accent/20 border border-accent/30 flex items-center justify-center gap-2 text-accent-light font-semibold">
              <Loader2 size={18} className="animate-spin" />
              {mode === "signin"
                ? "Signing in…"
                : mode === "signup"
                ? "Creating account…"
                : mode === "forgot"
                ? "Sending code…"
                : mode === "reset"
                ? "Resetting password…"
                : "Verifying…"}
            </div>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full py-3 rounded-xl font-bold text-white bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              <Mail size={16} />
              {mode === "signin"
                ? "Sign In"
                : mode === "signup"
                ? "Sign Up"
                : mode === "forgot"
                ? "Send Reset Code"
                : mode === "reset"
                ? "Reset Password"
                : "Verify & Sign In"}
            </button>
          )}

          {mode !== "confirm" && mode !== "reset" && (
            <p className="text-xs text-gray-500 text-center">
              {mode === "signin" ? (
                <>
                  No account?{" "}
                  <button onClick={() => setMode("signup")} className="text-accent-light hover:underline">
                    Sign up
                  </button>
                </>
              ) : mode === "forgot" ? (
                <>
                  Remember it?{" "}
                  <button onClick={() => setMode("signin")} className="text-accent-light hover:underline">
                    Sign in
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{" "}
                  <button onClick={() => setMode("signin")} className="text-accent-light hover:underline">
                    Sign in
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
