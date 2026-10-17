import { redirect } from "next/navigation";
import { isOwner } from "@/lib/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await isOwner()) redirect("/");
  return (
    <section className="card login">
      <h1>Sign in</h1>
      <p className="muted">Only the owner can view this dashboard or approve anything.</p>
      <LoginForm />
    </section>
  );
}
