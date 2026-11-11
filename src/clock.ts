/**
 * The single source of "now". Everything time-dependent (date resolution, what gets
 * stamped on stored turns, "today" in the prompt) reads from here, so tests and the
 * seed script can move the clock without touching the system time.
 */
let override: Date | null = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : null;

export const clock = {
  now(): Date {
    return override ? new Date(override) : new Date();
  },
  set(at: Date | null): void {
    override = at ? new Date(at) : null;
  },
};
