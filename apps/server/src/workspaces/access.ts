// Session bookkeeping only. Caller verifies actual platform login and controls collectors.
import { randomUUID } from 'node:crypto';
import { WorkspaceError, type Platform, type PlatformIdentity, WorkspaceRegistry } from './registry.js';

interface Session extends PlatformIdentity { session_id: string }
export class WorkspaceAccess {
  private space: string | null = null;
  private generation = randomUUID();
  private readonly sessions = new Map<Platform, Session>();

  constructor(private readonly registry: WorkspaceRegistry) {}

  /** Known binding required; unknown accounts must go through explicit create/bind first. */
  connect(verifiedIdentity: PlatformIdentity): string {
    const target = this.registry.find(verifiedIdentity);
    if (!target) throw new WorkspaceError('WORKSPACE_CHOICE_REQUIRED');
    if (this.space !== null && this.space !== target.space_id) {
      // Runtime must quiesce and leave the current space before changing DBs.
      throw new WorkspaceError('WORKSPACE_SWITCH_REQUIRED');
    }
    const sessionId = randomUUID();
    this.sessions.set(verifiedIdentity.platform, { ...verifiedIdentity, session_id: sessionId });
    this.space = target.space_id;
    this.generation = randomUUID();
    return sessionId;
  }

  /** A stale logout must never disconnect a newer login on that platform. */
  logout(platform: Platform, expectedSession: string): boolean {
    const session = this.sessions.get(platform);
    if (!session || session.session_id !== expectedSession) return false;
    this.sessions.delete(platform);
    if (this.sessions.size === 0) this.space = null;
    this.generation = randomUUID();
    return true;
  }

  /** A transport disconnect is not logout. Reconnection keeps the binding/data. */
  snapshot(): { space_id: string | null; epoch: string; sessions: Session[] } {
    return { space_id: this.space, epoch: this.generation,
      sessions: [...this.sessions.values()].map((session) => ({ ...session })) };
  }
  isCurrent(spaceId: string, epoch: string): boolean {
    return this.space === spaceId && this.generation === epoch && this.sessions.size > 0;
  }
}
