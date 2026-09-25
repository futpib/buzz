import type { Metadata } from "next";
import Link from "next/link";

import { PAGE_TITLES } from "@/shared/page-title";

export const metadata: Metadata = { title: PAGE_TITLES.notFound };

export default function NotFound() {
  return (
    <main className="centered-state">
      <div className="state-mark">404</div>
      <h1>Page not found</h1>
      <p>The requested Buzz page does not exist.</p>
      <Link className="primary-button" href="/">
        Open Buzz
      </Link>
    </main>
  );
}
