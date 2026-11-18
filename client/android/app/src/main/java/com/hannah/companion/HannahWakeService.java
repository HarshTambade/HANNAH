package com.hannah.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.GZIPInputStream;

/**
 * "Hey HANNAH" on Android, natively: a foreground service of type microphone
 * (the system shows its notification the whole time, with Stop) that runs the
 * same on-device detector as the other apps, Vosk with a two-entry grammar
 * ("hey hannah" or anything else), so it can't transcribe speech and no audio
 * leaves the phone.
 *
 * - The person turns it on in HANNAH (Settings → Voice) while the app is open,
 *   as Android requires for a microphone service; it keeps listening when the
 *   app is in the background, until they press Stop or turn it off.
 * - The speech model (about 41 MB) is downloaded once over HTTPS from the
 *   HANNAH server and unpacked into the app's private storage.
 * - When HANNAH is on screen, a detection opens a voice turn directly. In the
 *   background, Android doesn't let apps bring themselves to the front, so it
 *   posts a "Tap to talk to HANNAH" notification instead.
 * - While HANNAH is listening to the person or speaking, the detector releases
 *   the microphone (pause) and takes it back afterwards (resume).
 */
public class HannahWakeService extends Service {

    public interface Listener {
        void onWake();
        void onState(String state, String detail);
    }

    static final String ACTION_START = "com.hannah.companion.wake.START";
    static final String ACTION_STOP = "com.hannah.companion.wake.STOP";
    static final String ACTION_PAUSE = "com.hannah.companion.wake.PAUSE";
    static final String ACTION_RESUME = "com.hannah.companion.wake.RESUME";
    static final String EXTRA_MODEL_URL = "modelUrl";
    static final String EXTRA_WAKE = "com.hannah.companion.wake.HEARD";

    private static final String CHANNEL_RUNNING = "hannah-wake-running";
    private static final String CHANNEL_HEARD = "hannah-wake-heard";
    private static final int NOTIFICATION_RUNNING = 4101;
    private static final int NOTIFICATION_HEARD = 4102;
    private static final float SAMPLE_RATE = 16000f;
    private static final String GRAMMAR = "[\"hey hannah\", \"[unk]\"]";
    private static final long COOLDOWN_MS = 3000;
    private static final String MODEL_DIR = "vosk-wake/vosk-model-small-en-us-0.15";

    static volatile Listener listener;
    static volatile boolean appVisible;
    static volatile String state = "off";
    static volatile String detail = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speech;
    private boolean paused;
    private long lastWake;
    private Thread loader;

    static void setState(String next, String why) {
        state = next;
        detail = why == null ? "" : why;
        Listener current = listener;
        if (current != null) current.onState(state, detail);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : String.valueOf(intent.getAction());
        if (ACTION_STOP.equals(action)) {
            shutdown();
            setState("off", "");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            paused = true;
            releaseMicrophone();
            if (model != null) setState("paused", "");
            return START_NOT_STICKY;
        }
        if (ACTION_RESUME.equals(action)) {
            paused = false;
            if (model != null) listen();
            return START_NOT_STICKY;
        }
        // Start: become a foreground microphone service right away, as Android requires.
        createChannels();
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_RUNNING, runningNotification(), Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
        } catch (RuntimeException error) {
            // Android 14 refuses a microphone service started from the background or without the permission.
            setState("error", "Android didn't allow listening in the background. Open HANNAH and turn “Hey HANNAH” on again.");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (model == null && (loader == null || !loader.isAlive())) {
            final String url = intent == null ? null : intent.getStringExtra(EXTRA_MODEL_URL);
            setState("loading", "");
            loader = new Thread(() -> {
                try {
                    File dir = ensureModel(url);
                    Model loaded = new Model(dir.getAbsolutePath());
                    main.post(() -> {
                        model = loaded;
                        if (!paused) listen();
                        else setState("paused", "");
                    });
                } catch (Exception error) {
                    main.post(() -> {
                        setState("error", "The “Hey HANNAH” speech model couldn't be loaded: " + error.getMessage());
                        stopSelf();
                    });
                }
            }, "hannah-wake-model");
            loader.start();
        } else if (model != null && !paused) {
            listen();
        }
        return START_STICKY;
    }

    private void listen() {
        if (model == null || speech != null) return;
        try {
            Recognizer recognizer = new Recognizer(model, SAMPLE_RATE, GRAMMAR);
            speech = new SpeechService(recognizer, SAMPLE_RATE);
            speech.startListening(new RecognitionListener() {
                @Override public void onPartialResult(String hypothesis) { check(hypothesis, "partial"); }
                @Override public void onResult(String hypothesis) { check(hypothesis, "text"); }
                @Override public void onFinalResult(String hypothesis) { check(hypothesis, "text"); }
                @Override public void onError(Exception error) {
                    releaseMicrophone();
                    setState("error", "The microphone stopped: " + error.getMessage());
                }
                @Override public void onTimeout() { }
            });
            setState("listening", "");
        } catch (IOException | RuntimeException error) {
            releaseMicrophone();
            setState("error", "The microphone couldn't be opened: " + error.getMessage());
        }
    }

    /** Vosk reports JSON like {"partial": "hey hannah"} or {"text": "hey hannah"}. */
    private void check(String hypothesis, String field) {
        if (hypothesis == null) return;
        String text;
        try {
            text = new JSONObject(hypothesis).optString(field, "");
        } catch (Exception error) {
            return;
        }
        if (!heardWakePhrase(text)) return;
        long now = System.currentTimeMillis();
        if (now - lastWake < COOLDOWN_MS) return;
        lastWake = now;
        // Hand the microphone to the voice turn.
        releaseMicrophone();
        paused = true;
        setState("paused", "");
        Listener current = listener;
        if (appVisible && current != null) {
            current.onWake();
        } else {
            postHeardNotification();
        }
        // If nothing takes the microphone, listen again.
        main.postDelayed(() -> {
            if (paused && speech == null && model != null && !appVisible) {
                paused = false;
                listen();
            }
        }, 15000);
    }

    static boolean heardWakePhrase(String text) {
        String normalized = text == null ? "" : text.toLowerCase().replaceAll("[^a-z ]", " ").replaceAll("\\s+", " ").trim();
        return normalized.contains("hey hannah");
    }

    private void releaseMicrophone() {
        if (speech != null) {
            speech.stop();
            speech.shutdown();
            speech = null;
        }
    }

    private void shutdown() {
        releaseMicrophone();
        if (model != null) {
            model.close();
            model = null;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTIFICATION_HEARD);
    }

    @Override
    public void onDestroy() {
        shutdown();
        if (!"error".equals(state)) setState("off", "");
        super.onDestroy();
    }

    // ----- the model: downloaded once over HTTPS, unpacked into private storage -----

    private File ensureModel(String url) throws IOException {
        File dir = new File(getFilesDir(), MODEL_DIR);
        File ready = new File(dir, ".ready");
        if (ready.exists()) return dir;
        if (url == null || !url.startsWith("https://")) throw new IOException("the model address must be https");
        File root = new File(getFilesDir(), "vosk-wake");
        deleteTree(root);
        if (!root.mkdirs() && !root.isDirectory()) throw new IOException("no space for the model");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setInstanceFollowRedirects(true);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("the server answered " + connection.getResponseCode());
            try (InputStream body = new GZIPInputStream(new BufferedInputStream(connection.getInputStream()))) {
                untar(body, root);
            }
        } finally {
            connection.disconnect();
        }
        if (!new File(dir, "am").isDirectory()) throw new IOException("the download wasn't the expected model");
        if (!ready.createNewFile() && !ready.exists()) throw new IOException("couldn't finish unpacking");
        return dir;
    }

    /** A minimal ustar reader: regular files and folders only; nothing may land outside the target. */
    static void untar(InputStream in, File target) throws IOException {
        String base = target.getCanonicalPath() + File.separator;
        byte[] header = new byte[512];
        byte[] buffer = new byte[64 * 1024];
        long total = 0;
        while (true) {
            if (!readFully(in, header)) return;
            boolean empty = true;
            for (byte value : header) if (value != 0) { empty = false; break; }
            if (empty) return;
            String name = field(header, 0, 100);
            String prefix = field(header, 345, 155);
            if (!prefix.isEmpty()) name = prefix + "/" + name;
            long size = Long.parseLong(field(header, 124, 12).trim().isEmpty() ? "0" : field(header, 124, 12).trim(), 8);
            char type = (char) header[156];
            total += size;
            if (total > 200L * 1024 * 1024) throw new IOException("the model is larger than expected");
            File out = new File(target, name);
            if (!out.getCanonicalPath().startsWith(base)) throw new IOException("the model archive has an unsafe path");
            long remaining = size;
            if (type == '5') {
                if (!out.mkdirs() && !out.isDirectory()) throw new IOException("couldn't create " + name);
            } else if (type == '0' || type == 0) {
                File parent = out.getParentFile();
                if (parent != null && !parent.mkdirs() && !parent.isDirectory()) throw new IOException("couldn't create " + name);
                try (FileOutputStream file = new FileOutputStream(out)) {
                    while (remaining > 0) {
                        int read = in.read(buffer, 0, (int) Math.min(buffer.length, remaining));
                        if (read < 0) throw new IOException("the download was cut short");
                        file.write(buffer, 0, read);
                        remaining -= read;
                    }
                }
            }
            // Skip any data not written (links, extended headers) and the padding to 512 bytes.
            long skip = remaining + ((512 - (size % 512)) % 512);
            while (skip > 0) {
                long skipped = in.skip(skip);
                if (skipped <= 0) {
                    if (in.read() < 0) throw new IOException("the download was cut short");
                    skipped = 1;
                }
                skip -= skipped;
            }
        }
    }

    private static boolean readFully(InputStream in, byte[] into) throws IOException {
        int offset = 0;
        while (offset < into.length) {
            int read = in.read(into, offset, into.length - offset);
            if (read < 0) {
                if (offset == 0) return false;
                throw new IOException("the download was cut short");
            }
            offset += read;
        }
        return true;
    }

    private static String field(byte[] header, int start, int length) {
        int end = start;
        while (end < start + length && header[end] != 0) end++;
        return new String(header, start, end - start, java.nio.charset.StandardCharsets.US_ASCII);
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    // ----- notifications -----

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel running = new NotificationChannel(CHANNEL_RUNNING, "Listening for “Hey HANNAH”", NotificationManager.IMPORTANCE_LOW);
        running.setDescription("Shown while HANNAH listens for her name on this phone. Nothing leaves the phone.");
        manager.createNotificationChannel(running);
        NotificationChannel heard = new NotificationChannel(CHANNEL_HEARD, "“Hey HANNAH” heard", NotificationManager.IMPORTANCE_HIGH);
        heard.setDescription("Tap to talk to HANNAH after you said her name.");
        manager.createNotificationChannel(heard);
    }

    private PendingIntent openApp(boolean wake) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (wake) open.putExtra(EXTRA_WAKE, true);
        return PendingIntent.getActivity(this, wake ? 2 : 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification runningNotification() {
        Intent stop = new Intent(this, HannahWakeService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 3, stop, PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_RUNNING)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Listening for “Hey HANNAH”")
            .setContentText("On this phone only. Tap Stop to turn it off.")
            .setOngoing(true)
            .setContentIntent(openApp(false))
            .addAction(0, "Stop", stopIntent)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private void postHeardNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        Notification heard = new NotificationCompat.Builder(this, CHANNEL_HEARD)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("You said “Hey HANNAH”")
            .setContentText("Tap to talk to HANNAH.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setTimeoutAfter(60000)
            .setContentIntent(openApp(true))
            .build();
        manager.notify(NOTIFICATION_HEARD, heard);
    }

    static Intent command(Context context, String action) {
        return new Intent(context, HannahWakeService.class).setAction(action);
    }
}
