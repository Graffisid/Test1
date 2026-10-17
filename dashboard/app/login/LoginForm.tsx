"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "../auth-actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, { error: null });
  return (
    <form action={action} className="login-form">
      <label className="edit-field">
        <span>Owner password</span>
        <input type="password" name="password" autoComplete="current-password" required maxLength={256} autoFocus />
      </label>
      <button type="submit" className="btn primary" disabled={pending}>{pending ? "Checking…" : "Sign in"}</button>
      {state.error && <p className="notice err" role="alert"><span aria-hidden="true">!</span> {state.error}</p>}
    </form>
  );
}
