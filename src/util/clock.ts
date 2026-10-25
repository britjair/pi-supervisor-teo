/** Единственный источник текущего времени. В тестах подменяется FakeClock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
