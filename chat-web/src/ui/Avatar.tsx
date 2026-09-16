import type { ProfileView } from "@/server/types";

export function Avatar({
  profile,
  small = false,
}: {
  profile: ProfileView;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={small ? "avatar avatar-small" : "avatar"}
      style={{ background: profile.color }}
    >
      {profile.initials}
    </span>
  );
}
