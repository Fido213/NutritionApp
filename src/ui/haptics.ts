/**
 * Subtle haptic feedback for touch interactions (builder add/remove/save).
 * @capacitor/haptics is already a dependency + registered native plugin;
 * on web/desktop this silently no-ops. Never let a haptic failure surface.
 */
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

export async function hapticLight(): Promise<void> {
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    /* unsupported platform — fine */
  }
}

export async function hapticSuccess(): Promise<void> {
  try {
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    /* unsupported platform — fine */
  }
}
