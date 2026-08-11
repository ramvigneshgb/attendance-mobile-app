import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import NetInfo from '@react-native-community/netinfo';

// ==========================================
// ⚙️ SYSTEM CONFIGURATION
// ==========================================
const LOGIN_URL = "https://aspireintranet.xdemo.in/controllers/AuthController.php"; 
const PORTAL_URL = "https://aspireintranet.xdemo.in/controllers/AttendanceController.php";

// Task Names
const GEOFENCE_TASK_NAME = 'BACKGROUND_OFFICE_GEOFENCE';
const LOCATION_TRACKING_TASK = 'FOREGROUND_LOCATION_TRACKING';
const WIFI_CHECK_TASK = 'BACKGROUND_WIFI_CHECK';

// 📍 Exact GPS coordinates & Wi-Fi
const OFFICE_LATITUDE = 26.843309; 
const OFFICE_LONGITUDE = 75.561144; 
const GEOFENCE_RADIUS = 100; 

const TARGET_SSID = 'iBUS@MUJ';

// ==========================================
// 👻 THE HEADLESS GHOST (Runs outside the UI)
// ==========================================
const executeBackgroundTrigger = async (action: 'CHECK_IN' | 'CHECK_OUT', source: string) => {
  try {
    // 1. Prevent Double-Firing (e.g., GPS checks you in, then Wi-Fi tries again)
    const lastAction = await AsyncStorage.getItem('last_action');
    if (lastAction === action) {
      console.log(`Skipping ${action}, already performed recently via another trigger.`);
      return;
    }

    // 2. Fetch Credentials
    const email = await AsyncStorage.getItem('user_email');
    const pass = await AsyncStorage.getItem('user_password');
    if (!email || !pass) return;

    // 3. Authenticate
    const loginPayload = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(pass)}&login=`;
    const authReq = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: loginPayload
    });

    if (!authReq.url.includes('dashboard.php')) return;

    // 4. Trigger Check-in / Check-out
    const triggerPayload = action === 'CHECK_IN' ? "checkin_btn=" : "checkout_btn=";
    await fetch(PORTAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: triggerPayload
    });
    
    // 5. Save the state so we don't spam the server
    await AsyncStorage.setItem('last_action', action);
    console.log(`✅ Headless ${action} executed successfully via ${source}!`);
  } catch (e) {
    console.error(`Headless trigger failed via ${source}:`, e);
  }
};

// Define Geofence Task
TaskManager.defineTask(GEOFENCE_TASK_NAME, ({ data, error }: any) => {
  if (error) {
    console.error("Geofence Error:", error.message);
    return;
  }
  if (data) {
    const { eventType } = data;
    if (eventType === Location.GeofencingEventType.Enter) {
      console.log("📍 Entered Office Zone");
      executeBackgroundTrigger('CHECK_IN', 'GEOFENCE');
    } else if (eventType === Location.GeofencingEventType.Exit) {
      console.log("📍 Exited Office Zone");
      executeBackgroundTrigger('CHECK_OUT', 'GEOFENCE');
    }
  }
});

// Define Wi-Fi Fallback Task
TaskManager.defineTask(WIFI_CHECK_TASK, async () => {
  try {
    const netState = await NetInfo.fetch();
    if (netState.type === 'wifi' && netState.details?.ssid === TARGET_SSID) {
      console.log("📡 Target Wi-Fi Detected in background!");
      await executeBackgroundTrigger('CHECK_IN', 'WIFI');
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (error) {
    console.error("Wi-Fi Task Failed:", error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ==========================================
// 📱 APP USER INTERFACE
// ==========================================
export default function App() {
  const [credentials, setCredentials] = useState<{ email: string; pass: string } | null>(null);
  const [emailInput, setEmailInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [status, setStatus] = useState('Checking location systems...');

 useEffect(() => {
    const initApp = async () => {
      try {
        const { status: foregroundStatus } = await Location.requestForegroundPermissionsAsync();
        if (foregroundStatus !== 'granted') {
          setStatus('⚠️ Location permission required.');
          return;
        }
        
        const { status: backgroundStatus } = await Location.requestBackgroundPermissionsAsync();
        if (backgroundStatus !== 'granted') {
          setStatus('⚠️ Background permission denied.');
          return;
        }

        const savedEmail = await AsyncStorage.getItem('user_email');
        const savedPassword = await AsyncStorage.getItem('user_password');
        
        if (savedEmail && savedPassword) {
          setCredentials({ email: savedEmail, pass: savedPassword });
          await activateAutomation();
          setStatus('📡 Geofence & Wi-Fi Monitoring Active...');
        } else {
          setStatus('Awaiting user login...');
        }
      } catch (err) {
        console.error("Initialization error:", err);
        setStatus('⚠️ Error initializing automation systems.');
      }
    };

    initApp();
  }, []);

  const activateAutomation = async () => {
    // 1. Start High-Priority Foreground Service (Prevents Android Sleep)
    await Location.startLocationUpdatesAsync(LOCATION_TRACKING_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 60000,
      distanceInterval: 10,
      foregroundService: {
        notificationTitle: "Attendance Automation Active",
        notificationBody: "Monitoring location to automate check-in.",
        notificationColor: "#2563eb",
      },
    });

    // 2. Start Geofence
    await Location.startGeofencingAsync(GEOFENCE_TASK_NAME, [{
      identifier: 'Office',
      latitude: OFFICE_LATITUDE, 
      longitude: OFFICE_LONGITUDE, 
      radius: GEOFENCE_RADIUS,
      notifyOnEnter: true,
      notifyOnExit: true,
    }]);

    // 3. Register Wi-Fi Background Poller (Fallback)
    await BackgroundFetch.registerTaskAsync(WIFI_CHECK_TASK, {
      minimumInterval: 15 * 60, // 15 minutes
      stopOnTerminate: false,
      startOnBoot: true,
    });
  };

  const handleLoginSetup = async () => {
    if (!emailInput || !passwordInput) {
      Alert.alert('Error', 'Please enter both email and password.');
      return;
    }

    setIsLoggingIn(true);
    try {
      const loginPayload = `email=${encodeURIComponent(emailInput)}&password=${encodeURIComponent(passwordInput)}&login=`;
      const res = await fetch(LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginPayload
      });

      if (res.url.includes('dashboard.php')) {
        await AsyncStorage.setItem('user_email', emailInput);
        await AsyncStorage.setItem('user_password', passwordInput);
        
        // Reset last action on fresh login
        await AsyncStorage.setItem('last_action', 'NONE');
        
        setCredentials({ email: emailInput, pass: passwordInput });
        
        await activateAutomation();
        
        setStatus('📡 Geofence & Wi-Fi Monitoring Active...');
        Alert.alert('Success', 'Credentials verified and automation activated!');
      } else {
        Alert.alert('Login Failed', 'Invalid email or password.');
      }
    } catch (err) {
      Alert.alert('Error', 'Unable to reach authentication server.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    // Stop all tasks
    await Location.stopLocationUpdatesAsync(LOCATION_TRACKING_TASK).catch(()=>null);
    await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME).catch(()=>null);
    await BackgroundFetch.unregisterTaskAsync(WIFI_CHECK_TASK).catch(()=>null);

    await AsyncStorage.removeItem('user_email');
    await AsyncStorage.removeItem('user_password');
    await AsyncStorage.removeItem('last_action');
    
    setCredentials(null);
    setStatus('Awaiting user login...');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Office Attendance</Text>
      
      <View style={styles.statusBox}>
        <Text style={styles.statusTitle}>System Status</Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      {!credentials ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Account Setup</Text>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#888"
            value={emailInput}
            onChangeText={setEmailInput}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor="#888"
            secureTextEntry
            value={passwordInput}
            onChangeText={setPasswordInput}
          />
          <TouchableOpacity style={styles.button} onPress={handleLoginSetup} disabled={isLoggingIn}>
            {isLoggingIn ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Save Credentials</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.card, styles.activeCard]}>
          <Text style={styles.cardTitle}>Automation Active</Text>
          <Text style={styles.accountText}>Logged in as:</Text>
          <Text style={styles.emailText}>{credentials.email}</Text>
          
          <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
            <Text style={styles.logoutText}>Reset Credentials</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    padding: 24,
    justifyContent: 'center',
  },
  header: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#f8fafc',
    marginBottom: 20,
    textAlign: 'center',
  },
  statusBox: {
    backgroundColor: '#1e293b',
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statusTitle: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  statusText: {
    color: '#38bdf8',
    fontSize: 14,
    fontWeight: '500',
  },
  card: {
    backgroundColor: '#1e293b',
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#334155',
  },
  activeCard: {
    borderColor: '#22c55e',
  },
  cardTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    padding: 14,
    borderRadius: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  button: {
    backgroundColor: '#2563eb',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 16,
  },
  accountText: {
    color: '#94a3b8',
    fontSize: 14,
  },
  emailText: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
    marginBottom: 20,
  },
  logoutButton: {
    backgroundColor: '#334155',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  logoutText: {
    color: '#f1f5f9',
    fontWeight: '500',
  },
});