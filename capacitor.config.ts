import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.deltastars.store',
  appName: 'نجوم دلتا',
  webDir: 'www',  // Static web assets directory
  server: {
    androidScheme: 'https',
    url: 'https://deltastars.netlify.app',
    cleartext: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: '#0b1d0b',
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true,
      showSpinner: true,
      spinnerColor: '#ca8a04',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b1d0b',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
  android: {
    backgroundColor: '#0b1d0b',
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  ios: {
    backgroundColor: '#0b1d0b',
    contentMode: 'mobile',
    backgroundColorDark: '#0b1d0b',
  },
};

export default config;
