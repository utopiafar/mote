import type {QueryInput} from '../query-contracts.js';
import {
  defineSkillDescriptor,
  defineTaskDescriptor,
  TaskContractError,
  type SkillDescriptor,
  type TaskDescriptor,
  type TaskPack,
  type TaskProfile,
  type TaskResponseMode,
  type TaskSelection,
} from './descriptor.js';

export interface PreparedTask {
  readonly id: string;
  readonly version: string;
  readonly profile: TaskProfile;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly language: NonNullable<QueryInput['language']>;
  readonly responseMode: TaskResponseMode;
  readonly skill?: SkillDescriptor;
}

/** Versioned task and procedure contributions. Registration is atomic and the
 * returned disposer retires exactly the installed identities. */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskDescriptor>();
  private readonly skills = new Map<string, SkillDescriptor>();

  register(pack: TaskPack): () => void | Promise<void> {
    const tasks = (pack.tasks ?? []).map(defineTaskDescriptor);
    const skills = (pack.skills ?? []).map(defineSkillDescriptor);
    const taskIds = new Set<string>(), skillIds = new Set<string>();
    for (const descriptor of tasks) {
      if (taskIds.has(descriptor.id) || this.tasks.has(descriptor.id)) throw new TaskContractError('duplicate_task', `Task id is already registered: ${descriptor.id}`);
      taskIds.add(descriptor.id);
    }
    for (const descriptor of skills) {
      if (skillIds.has(descriptor.id) || this.skills.has(descriptor.id)) throw new TaskContractError('duplicate_skill', `Skill id is already registered: ${descriptor.id}`);
      skillIds.add(descriptor.id);
    }
    for (const descriptor of tasks) this.tasks.set(descriptor.id, descriptor);
    for (const descriptor of skills) this.skills.set(descriptor.id, descriptor);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      for (const descriptor of tasks) if (this.tasks.get(descriptor.id) === descriptor) this.tasks.delete(descriptor.id);
      for (const descriptor of skills) if (this.skills.get(descriptor.id) === descriptor) this.skills.delete(descriptor.id);
      return pack.dispose?.();
    };
  }

  skill(id: string): SkillDescriptor {
    const skill = this.skills.get(id);
    if (!skill) throw new TaskContractError('unknown_skill', `Unknown Mote skill: ${id}`);
    return skill;
  }

  prepare(input: QueryInput): PreparedTask {
    const skill = input.skill === undefined ? undefined : this.skill(input.skill);
    const descriptor = this.selectTask(input.taskSelection, input);
    // A procedure contributes only a default. Explicit Host policy and the
    // selected task's retrieval scope remain authoritative.
    const responseMode = input.responseMode ?? skill?.responseMode ?? descriptor.profile.output;
    return Object.freeze({
      id: descriptor.id,
      version: descriptor.version,
      profile: descriptor.profile,
      outputSchema: descriptor.outputSchema,
      language: input.language ?? 'zh-CN',
      responseMode,
      ...(skill ? {skill} : {}),
    });
  }

  private selectTask(selection: TaskSelection | undefined, input: QueryInput): TaskDescriptor {
    if (selection !== undefined) {
      if (!selection || typeof selection !== 'object' || Array.isArray(selection) || typeof selection.id !== 'string' || typeof selection.version !== 'string') {
        throw new TaskContractError('invalid_task_selection', 'Task selection requires an exact id and version.');
      }
      const descriptor = this.tasks.get(selection.id);
      if (!descriptor) throw new TaskContractError('unknown_task', `Unknown Mote task: ${selection.id}`);
      if (descriptor.version !== selection.version) throw new TaskContractError('task_version_mismatch', `Task ${selection.id} requires version ${descriptor.version}.`);
      return descriptor;
    }
    const matches = [...this.tasks.values()].filter(descriptor => descriptor.select(input));
    if (!matches.length) throw new TaskContractError('invalid_task_selection', 'No registered task accepts this Host selection.');
    const priority = Math.max(...matches.map(descriptor => descriptor.priority ?? 0));
    const selected = matches.filter(descriptor => (descriptor.priority ?? 0) === priority);
    if (selected.length !== 1) throw new TaskContractError('ambiguous_task', 'Task selection must resolve to exactly one highest-priority descriptor.');
    return selected[0];
  }
}

export const defaultTaskRegistry = new TaskRegistry();
