import type { ProfileView } from "@/server/types";
import { AuthenticatedImage } from "@/ui/AuthenticatedImage";

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
      data-profile-pubkey={profile.pubkey}
      style={{ background: profile.color }}
    >
      {profile.initials}
      {profile.picture ? (
        <AuthenticatedImage
          alt={`${profile.name} avatar`}
          src={profile.picture}
          variant="avatar"
        />
      ) : null}
    </span>
  );
}
