import Link from "next/link";

export default function ChannelNotFound() {
  return (
    <main className="centered-state">
      <div className="state-mark">#</div>
      <h1>Channel unavailable</h1>
      <p>
        This identity is not a member of that channel, or it no longer exists.
      </p>
      <Link className="primary-button" href="/">
        Open Buzz
      </Link>
    </main>
  );
}
