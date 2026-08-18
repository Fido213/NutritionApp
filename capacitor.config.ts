import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.everydayfuel.app',
  appName: 'EverydayFuel',
  webDir: 'dist',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    CapacitorSQLite: {
      iosIsEncryption: false,
      iosBiometric: {
        biometricAuth: false,
        biometricTitle: "Biometric login for sqlite db"
      },
      androidIsEncryption: false,
      androidBiometric: {
        biometricAuth: false,
        biometricTitle: "Biometric login for sqlite db"
      }
    }
  }
};

export default config;
