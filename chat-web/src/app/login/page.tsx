import { redirect } from "next/navigation";

import { getCurrentSession } from "@/server/auth";
import { LoginForm } from "@/ui/LoginForm";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (await getCurrentSession()) redirect("/");
  const params = await searchParams;
  const requested = typeof params.next === "string" ? params.next : "/";
  const nextPath =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  return <LoginForm nextPath={nextPath} />;
}
