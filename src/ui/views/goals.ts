import { store } from '../state';

export function renderGoals() {
  const state = store.getState();
  const { todayGoals } = state;

  const calInput = document.getElementById('goal-cal') as HTMLInputElement | null;
  const proInput = document.getElementById('goal-pro') as HTMLInputElement | null;
  const carbInput = document.getElementById('goal-carb') as HTMLInputElement | null;
  const fatInput = document.getElementById('goal-fat') as HTMLInputElement | null;
  const waterInput = document.getElementById('goal-water') as HTMLInputElement | null;

  if (calInput) calInput.value = todayGoals.caloriesTarget.toString();
  if (proInput) proInput.value = todayGoals.proteinTarget.toString();
  if (carbInput) carbInput.value = todayGoals.carbsTarget.toString();
  if (fatInput) fatInput.value = todayGoals.fatTarget.toString();
  if (waterInput) waterInput.value = todayGoals.waterTarget.toString();
}

export function readGoalsForm() {
  const calInput = document.getElementById('goal-cal') as HTMLInputElement | null;
  const proInput = document.getElementById('goal-pro') as HTMLInputElement | null;
  const carbInput = document.getElementById('goal-carb') as HTMLInputElement | null;
  const fatInput = document.getElementById('goal-fat') as HTMLInputElement | null;
  const waterInput = document.getElementById('goal-water') as HTMLInputElement | null;

  return {
    caloriesTarget: calInput ? parseFloat(calInput.value) || 2500 : 2500,
    proteinTarget: proInput ? parseFloat(proInput.value) || 150 : 150,
    carbsTarget: carbInput ? parseFloat(carbInput.value) || 250 : 250,
    fatTarget: fatInput ? parseFloat(fatInput.value) || 80 : 80,
    waterTarget: waterInput ? parseFloat(waterInput.value) || 4000 : 4000
  };
}
