import { DailyTotals, GoalTargets, HydrationBreakdown, ScoreResult } from '@domain/types';
import { getTodayDateString } from '@utils/dates';
import { getDefaultGoalTargets } from '@domain/goals';

export interface AppState {
  selectedDate: string;
  historyViewMode: 'week' | 'month' | 'year';
  todayTotals: DailyTotals;
  todayGoals: GoalTargets;
  todayHydration: HydrationBreakdown;
  todayLogs: any[];
  currentScore: ScoreResult | null;
  activeModal: string | null;
  selectedLogForAction: any | null;
}

const defaultState: AppState = {
  selectedDate: getTodayDateString(),
  historyViewMode: 'week',
  todayTotals: {
    date: getTodayDateString(),
    calories: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
    waterMl: 0
  },
  todayGoals: getDefaultGoalTargets(),
  todayHydration: {
    explicit: 0,
    drink: 0,
    food: 0,
    effectiveTotal: 0,
    target: 4000
  },
  todayLogs: [],
  currentScore: null,
  activeModal: null,
  selectedLogForAction: null
};

type StateListener = (state: AppState) => void;

class StateStore {
  private state: AppState = { ...defaultState };
  private listeners: Set<StateListener> = new Set();

  getState(): AppState {
    return { ...this.state };
  }

  setState(partial: Partial<AppState>) {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (err) {
        console.error('State listener error:', err);
      }
    }
  }
}

export const store = new StateStore();
