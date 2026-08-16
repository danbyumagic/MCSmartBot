export type CapabilityAccess = "viewer" | "operator" | "owner";

export type CapabilityEffect =
  | "read"
  | "communicate"
  | "inventory"
  | "world-change"
  | "destructive"
  | "administrative";

export type MissionExposure = "public" | "internal" | "forbidden";

export interface CapabilityPolicy {
  readonly minimumRole: CapabilityAccess;
  readonly effect: CapabilityEffect;
  readonly reversible: boolean;
  readonly mission: MissionExposure;
}

const ROLE_RANK: Readonly<Record<CapabilityAccess, number>> = Object.freeze({
  viewer: 0,
  operator: 1,
  owner: 2,
});

const ACCESS_VALUES = new Set<CapabilityAccess>(["viewer", "operator", "owner"]);
const EFFECT_VALUES = new Set<CapabilityEffect>([
  "read",
  "communicate",
  "inventory",
  "world-change",
  "destructive",
  "administrative",
]);
const MISSION_VALUES = new Set<MissionExposure>(["public", "internal", "forbidden"]);

/** Reject malformed policy metadata at every dynamic registration boundary. */
export function assertCapabilityPolicy(policy: unknown): asserts policy is CapabilityPolicy {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error("capability policy is required");
  }
  const value = policy as Record<string, unknown>;
  if (!ACCESS_VALUES.has(value.minimumRole as CapabilityAccess) ||
      !EFFECT_VALUES.has(value.effect as CapabilityEffect) ||
      typeof value.reversible !== "boolean" ||
      !MISSION_VALUES.has(value.mission as MissionExposure)) {
    throw new Error("capability policy is invalid");
  }
}

/** Creates an immutable policy snapshot suitable for capability registration. */
export function createCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicy {
  assertCapabilityPolicy(policy);
  return Object.freeze({ ...policy });
}

/** Keeps registrations insulated from a caller's policy object. */
export function cloneCapabilityPolicy(policy: CapabilityPolicy): CapabilityPolicy {
  return createCapabilityPolicy(policy);
}

export function roleSatisfies(
  role: CapabilityAccess,
  policy: CapabilityPolicy,
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[policy.minimumRole];
}
