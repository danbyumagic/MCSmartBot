import { sameMinecraftUsername } from "../bot/playerIdentity.js";

export class NotOwnerError extends Error {
  constructor(public readonly attemptedBy: string) {
    super(`User '${attemptedBy}' is not the owner.`);
    this.name = "NotOwnerError";
  }
}

export function isOwner(username: string, ownerUsername: string): boolean {
  return sameMinecraftUsername(username, ownerUsername);
}

export function requireOwner(username: string, ownerUsername: string): void {
  if (!isOwner(username, ownerUsername)) throw new NotOwnerError(username);
}

export function refusalMessage(ownerUsername: string): string {
  return `Sorry, I only take orders from ${ownerUsername}.`;
}
