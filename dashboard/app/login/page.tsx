import { redirect } from "next/navigation";
import { isOwner } from "@/lib/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isOwner()) redirect("/");
  return (
    <section className="login rise">
      <span className="login-mark" aria-hidden="true">N</span>
      <h1>Welcome back</h1>
      <p className="muted">Sign in to see what your AI team did and approve their work.</p>
      <LoginForm />
    </section>
  );
}
