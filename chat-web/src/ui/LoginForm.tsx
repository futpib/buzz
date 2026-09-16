"use client";

import { KeyRound, LoaderCircle, LockKeyhole } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  forgetCredential,
  loadCredential,
  makeAuthEvent,
  parseAuthTag,
  storeCredential,
  type BrowserCredential,
} from "@/client/identity";

type LoginStart = {
  attemptId: string;
  challenge: string;
  relayUrl: string;
};

async function errorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [nsec, setNsec] = useState("");
  const [authTag, setAuthTag] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const automaticAttempt = useRef(false);

  const login = useCallback(
    async (credential: BrowserCredential) => {
      setPending(true);
      setError(null);
      try {
        const startResponse = await fetch("/api/auth/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!startResponse.ok) {
          throw new Error(
            await errorMessage(startResponse, "Login could not start"),
          );
        }
        const start = (await startResponse.json()) as LoginStart;
        const event = makeAuthEvent(
          credential,
          start.challenge,
          start.relayUrl,
        );
        const sessionResponse = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attemptId: start.attemptId, event }),
        });
        if (!sessionResponse.ok) {
          throw new Error(await errorMessage(sessionResponse, "Login failed"));
        }
        storeCredential(credential);
        window.location.assign(nextPath);
      } catch (caught) {
        forgetCredential();
        setError(caught instanceof Error ? caught.message : "Login failed");
        setPending(false);
      }
    },
    [nextPath],
  );

  useEffect(() => {
    if (automaticAttempt.current) return;
    automaticAttempt.current = true;
    const stored = loadCredential();
    if (stored) void login(stored);
  }, [login]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      void login({ nsec: nsec.trim(), authTag: parseAuthTag(authTag) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    }
  };

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true">
          B
        </div>
        <div className="login-copy">
          <p className="eyebrow">Buzz for the web</p>
          <h1 id="login-title">Sign in to your workspace</h1>
          <p>
            Your nsec stays in this browser tab. Buzz receives only signed
            authentication proofs and signed messages.
          </p>
        </div>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="nsec">
            Secret key
          </label>
          <div className="secret-field">
            <KeyRound aria-hidden="true" size={18} />
            <input
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={pending}
              id="nsec"
              name="nsec"
              onChange={(event) => setNsec(event.target.value)}
              placeholder="nsec1…"
              required
              spellCheck={false}
              type="password"
              value={nsec}
            />
          </div>
          <details className="agent-credential">
            <summary>Agent login</summary>
            <label className="field-label" htmlFor="auth-tag">
              Optional NIP-OA auth tag
            </label>
            <textarea
              disabled={pending}
              id="auth-tag"
              onChange={(event) => setAuthTag(event.target.value)}
              placeholder='["auth", "owner…", "", "signature…"]'
              rows={3}
              spellCheck={false}
              value={authTag}
            />
          </details>
          {error ? (
            <p className="login-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="login-button" disabled={pending} type="submit">
            {pending ? (
              <LoaderCircle aria-hidden="true" className="spin" size={18} />
            ) : (
              <LockKeyhole aria-hidden="true" size={18} />
            )}
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="login-footnote">
          The key is kept in session storage so it is forgotten when this tab
          session ends.
        </p>
      </section>
    </main>
  );
}
