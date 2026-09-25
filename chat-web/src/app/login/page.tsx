import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getCurrentSession } from "@/server/auth";
import { getPairingRelayUrl } from "@/server/env";
import { PAGE_TITLES } from "@/shared/page-title";
import { LoginForm } from "@/ui/LoginForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: PAGE_TITLES.login };

type LoginPageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (await getCurrentSession()) redirect("/");
  const params = await searchParams;
  const requested = typeof params.next === "string" ? params.next : "/";
  const nextPath =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
  const pairingRelayUrl = await getPairingRelayUrl();
  return <LoginForm nextPath={nextPath} pairingRelayUrl={pairingRelayUrl} />;
}
