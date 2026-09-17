export type TypingParticipant = {
  pubkey: string;
  name: string;
};

export function typingLabel(participants: TypingParticipant[]): string {
  const names = participants.map((participant) => participant.name);
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  if (names.length === 3) {
    return `${names[0]}, ${names[1]}, and ${names[2]} are typing`;
  }
  return `${names[0]}, ${names[1]}, and ${names.length - 2} others are typing`;
}

export function TypingIndicator({
  participants,
}: {
  participants: TypingParticipant[];
}) {
  if (participants.length === 0) return null;
  return (
    <p aria-live="polite" className="typing-indicator" role="status">
      <span>{typingLabel(participants)}</span>
      <i aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
    </p>
  );
}
