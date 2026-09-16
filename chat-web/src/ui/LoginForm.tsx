"use client";

import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { QRCodeSVG } from "qrcode.react";

import {
  forgetCredential,
  loadCredential,
  makeAuthEvent,
  parseAuthTag,
  storeCredential,
  type BrowserCredential,
} from "@/client/identity";
import { BrowserPairingSession, type PairingSnapshot } from "@/client/pairing";

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

async function createBrowserSession(credential: BrowserCredential) {
  const startResponse = await fetch("/api/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!startResponse.ok) {
    throw new Error(await errorMessage(startResponse, "Login could not start"));
  }
  const start = (await startResponse.json()) as LoginStart;
  const event = makeAuthEvent(credential, start.challenge, start.relayUrl);
  const sessionResponse = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ attemptId: start.attemptId, event }),
  });
  if (!sessionResponse.ok) {
    throw new Error(await errorMessage(sessionResponse, "Login failed"));
  }
  storeCredential(credential);
}

export function LoginForm({
  nextPath,
  pairingRelayUrl,
}: {
  nextPath: string;
  pairingRelayUrl: string;
}) {
  const [nsec, setNsec] = useState("");
  const [authTag, setAuthTag] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<PairingSnapshot | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "selected">(
    "idle",
  );
  const automaticAttempt = useRef(false);
  const pairingSession = useRef<BrowserPairingSession | null>(null);
  const pairingCodeField = useRef<HTMLTextAreaElement | null>(null);
  const redirectTimer = useRef<number | null>(null);

  const authenticate = useCallback(async (credential: BrowserCredential) => {
    setPending(true);
    setError(null);
    try {
      await createBrowserSession(credential);
      return true;
    } catch (caught) {
      forgetCredential();
      setError(caught instanceof Error ? caught.message : "Login failed");
      setPending(false);
      return false;
    }
  }, []);

  const login = useCallback(
    async (credential: BrowserCredential) => {
      if (await authenticate(credential)) window.location.assign(nextPath);
    },
    [authenticate, nextPath],
  );

  const startPairing = useCallback(async () => {
    pairingSession.current?.dispose();
    setCopyStatus("idle");
    setError(null);
    const session = new BrowserPairingSession(pairingRelayUrl, {
      onChange: (snapshot) => {
        setPairing(snapshot);
        if (snapshot.step === "complete") {
          redirectTimer.current = window.setTimeout(
            () => window.location.assign(nextPath),
            250,
          );
        }
      },
      onNsec: (receivedNsec) =>
        authenticate({ nsec: receivedNsec, authTag: null }),
    });
    pairingSession.current = session;
    setPairing({
      step: "connecting",
      qrUri: "",
      appUri: "",
      sasCode: null,
      error: null,
    });
    try {
      await session.start();
    } catch {
      // The session publishes its user-facing failure through onChange.
    }
  }, [authenticate, nextPath, pairingRelayUrl]);

  useEffect(() => {
    if (automaticAttempt.current) return;
    automaticAttempt.current = true;
    const stored = loadCredential();
    if (stored) void login(stored);
  }, [login]);

  useEffect(
    () => () => {
      pairingSession.current?.dispose();
      if (redirectTimer.current !== null) {
        window.clearTimeout(redirectTimer.current);
      }
    },
    [],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      void login({ nsec: nsec.trim(), authTag: parseAuthTag(authTag) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed");
    }
  };

  const copyPairingCode = async () => {
    if (!pairing?.qrUri) return;
    const selectCode = () => {
      const field = pairingCodeField.current;
      if (!field) return;
      field.focus();
      field.select();
      field.setSelectionRange(0, field.value.length);
    };

    try {
      if (!window.isSecureContext || !navigator.clipboard?.writeText) {
        selectCode();
        if (!document.execCommand("copy")) {
          setCopyStatus("selected");
          return;
        }
      } else {
        await navigator.clipboard.writeText(pairing.qrUri);
      }
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 2_000);
    } catch {
      selectCode();
      setCopyStatus("selected");
    }
  };

  const cancelPairing = () => {
    pairingSession.current?.dispose();
    pairingSession.current = null;
    setPairing(null);
    setPending(false);
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
            Pair with Buzz Android or enter your nsec. The private key stays in
            this browser tab.
          </p>
        </div>

        <section className="pairing-card" aria-label="Pair with Buzz Android">
          {pairing === null ? (
            <>
              <div className="pairing-heading">
                <Smartphone aria-hidden="true" size={20} />
                <div>
                  <strong>Pair with Buzz Android</strong>
                  <span>No secret-key copy and paste</span>
                </div>
              </div>
              <button
                className="pairing-button"
                onClick={() => void startPairing()}
                type="button"
              >
                <ShieldCheck aria-hidden="true" size={18} />
                Start secure pairing
              </button>
            </>
          ) : null}

          {pairing?.step === "connecting" ? (
            <div className="pairing-status" role="status">
              <LoaderCircle aria-hidden="true" className="spin" size={23} />
              <strong>Creating a one-time pairing code…</strong>
            </div>
          ) : null}

          {pairing?.step === "waiting" ? (
            <div className="pairing-flow">
              <div className="pairing-qr">
                <QRCodeSVG
                  aria-label="Buzz Android pairing QR code"
                  bgColor="#ffffff"
                  fgColor="#15151a"
                  level="M"
                  marginSize={2}
                  size={188}
                  title="Buzz Android pairing QR code"
                  value={pairing.qrUri}
                />
              </div>
              <strong>Open this code in your signed-in Buzz phone</strong>
              <p>
                On this phone, tap below. On another phone, scan the QR from
                Settings → Send identity to desktop.
              </p>
              <a className="pairing-button" href={pairing.appUri}>
                <Smartphone aria-hidden="true" size={18} />
                Open Buzz Android
              </a>
              <div className="pairing-code-block">
                <label htmlFor="pairing-code">One-time pairing code</label>
                <textarea
                  aria-describedby="pairing-code-help"
                  autoCapitalize="none"
                  autoComplete="off"
                  id="pairing-code"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  ref={pairingCodeField}
                  rows={4}
                  spellCheck={false}
                  value={pairing.qrUri}
                  wrap="soft"
                />
                <span id="pairing-code-help">
                  {copyStatus === "selected"
                    ? "Selected — long-press the code and choose Copy."
                    : "If Copy is blocked on HTTP, long-press this code to copy it manually."}
                </span>
              </div>
              <div className="pairing-secondary-actions">
                <button onClick={() => void copyPairingCode()} type="button">
                  {copyStatus === "copied" ? (
                    <Check aria-hidden="true" size={15} />
                  ) : (
                    <Copy aria-hidden="true" size={15} />
                  )}
                  {copyStatus === "copied" ? "Copied" : "Copy code"}
                </button>
                <button onClick={cancelPairing} type="button">
                  <X aria-hidden="true" size={15} />
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {pairing?.step === "confirming" && pairing.sasCode ? (
            <div className="pairing-flow">
              <ShieldCheck aria-hidden="true" className="pairing-shield" />
              <strong>Does this code match Buzz Android?</strong>
              <div
                className="pairing-sas"
                aria-label={`Code ${pairing.sasCode}`}
                role="status"
              >
                {pairing.sasCode.slice(0, 3)} {pairing.sasCode.slice(3)}
              </div>
              <p>Only approve if the six digits are identical in both apps.</p>
              <button
                className="pairing-button"
                onClick={() => pairingSession.current?.confirmSas()}
                type="button"
              >
                <Check aria-hidden="true" size={18} />
                Codes match
              </button>
              <button
                className="pairing-cancel"
                onClick={() => pairingSession.current?.denySas()}
                type="button"
              >
                Codes do not match
              </button>
            </div>
          ) : null}

          {pairing?.step === "receiving" ? (
            <div className="pairing-status" role="status">
              <LoaderCircle aria-hidden="true" className="spin" size={23} />
              <strong>Waiting for approval in Buzz Android…</strong>
              <span>Return here after confirming the same code there.</span>
            </div>
          ) : null}

          {pairing?.step === "complete" ? (
            <div className="pairing-status pairing-success" role="status">
              <Check aria-hidden="true" size={24} />
              <strong>Identity received securely</strong>
            </div>
          ) : null}

          {pairing?.step === "error" ? (
            <div className="pairing-status pairing-failure" role="alert">
              <X aria-hidden="true" size={23} />
              <strong>{pairing.error ?? "Pairing failed."}</strong>
              <button
                className="pairing-button"
                onClick={() => void startPairing()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} />
                Try again
              </button>
            </div>
          ) : null}
        </section>

        <div className="login-divider">
          <span>or enter an nsec</span>
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
          The key is kept in session storage and is forgotten when this tab
          session ends.
        </p>
      </section>
    </main>
  );
}
