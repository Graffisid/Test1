import { redirect } from "next/navigation";
import { isOwner } from "@/lib/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isOwner()) redirect("/");
  return (
    <section className="login rise">
      <img src="/brand/trisanga-mark.png" alt="" width={64} height={64} className="login-logo" />
      <h1>Welcome back</h1>
      <p className="muted">Sign in to the Trisanga Story Studio: credit union stories from ONCU Insights.</p>
      <LoginForm />
    </section>
  );
}
