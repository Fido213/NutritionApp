import { FoodReference, HydrationBreakdown } from './types';

/**
 * Calculate effective hydration with gating rules.
 * 
 * GATING RULE:
 * If explicit water < target:
 *   effective = explicit only (drink + food stored but not counted)
 * If explicit water >= target:
 *   effective = explicit + eligible_drink + eligible_food
 */
export function calculateEffectiveHydration(
  explicit: number,
  drink: number, 
  food: number,
  target: number
): HydrationBreakdown {
  let effectiveTotal = explicit;

  if (explicit >= target) {
    effectiveTotal += drink + food;
  }

  return {
    explicit,
    drink,
    food,
    effectiveTotal,
    target
  };
}

/**
 * Classify a water log source based on food type.
 */
export function classifyWaterSource(foodReference: FoodReference | null): 'explicit' | 'drink' | 'food' {
  if (!foodReference) {
    return 'explicit'; // Assuming no food ref implies pure water entry
  }
  
  const name = foodReference.canonicalName.toLowerCase();
  
  if (name === 'water' || name === 'tap water' || name === 'bottled water') {
    return 'explicit';
  }

  const drinkKeywords = ['coffee', 'tea', 'soda', 'juice', 'milk', 'drink', 'beverage'];
  for (const keyword of drinkKeywords) {
    if (name.includes(keyword)) {
      return 'drink';
    }
  }

  return 'food';
}
