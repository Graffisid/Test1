import { redirect } from "next/navigation";

/** Connections now live in your profile. */
export default function Connections() {
  redirect("/profile/connections");
}
