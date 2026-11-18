package com.hannah.companion;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The web layer's handle on HannahWakeService ("Hey HANNAH" in the background).
 *
 * start asks for the microphone (and, on Android 13+, notifications, which
 * the always-visible "Listening" notification needs), then starts the
 * foreground service. Events: "wake" when the phrase is heard while HANNAH is
 * on screen or its notification is tapped, and "state" as the service runs.
 */
@CapacitorPlugin(
    name = "HannahWake",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }),
    }
)
public class HannahWakePlugin extends Plugin {

    @Override
    public void load() {
        HannahWakeService.listener = new HannahWakeService.Listener() {
            @Override public void onWake() { notifyListeners("wake", new JSObject().put("source", "phrase")); }
            @Override public void onState(String state, String detail) { notifyListeners("state", new JSObject().put("state", state).put("detail", detail)); }
        };
        HannahWakeService.appVisible = true;
        // Opened by tapping "You said Hey HANNAH": the web layer reads it with pendingWake().
    }

    @Override
    protected void handleOnResume() {
        HannahWakeService.appVisible = true;
    }

    @Override
    protected void handleOnPause() {
        HannahWakeService.appVisible = false;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent != null && intent.getBooleanExtra(HannahWakeService.EXTRA_WAKE, false)) {
            intent.removeExtra(HannahWakeService.EXTRA_WAKE);
            notifyListeners("wake", new JSObject().put("source", "notification"));
        }
    }

    /** True once if HANNAH was opened from the "You said Hey HANNAH" notification. */
    @PluginMethod
    public void pendingWake(PluginCall call) {
        Intent intent = getActivity() == null ? null : getActivity().getIntent();
        boolean pending = intent != null && intent.getBooleanExtra(HannahWakeService.EXTRA_WAKE, false);
        if (pending) intent.removeExtra(HannahWakeService.EXTRA_WAKE);
        call.resolve(new JSObject().put("pending", pending));
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(new JSObject()
            .put("state", HannahWakeService.state)
            .put("detail", HannahWakeService.detail)
            .put("microphone", getPermissionState("microphone").toString().toLowerCase()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        String url = call.getString("modelUrl");
        if (url == null || !url.startsWith("https://")) {
            call.reject("The speech model must come from an https address.", "BAD_REQUEST");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneAnswered");
            return;
        }
        askNotificationsThenStart(call);
    }

    @PermissionCallback
    private void microphoneAnswered(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("Microphone permission wasn't given, so HANNAH can't listen for her name.", "PERMISSION_DENIED");
            return;
        }
        askNotificationsThenStart(call);
    }

    private void askNotificationsThenStart(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        // Without notifications Android still runs the service, but the person can't see or stop it from the shade, so don't start.
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("Notifications weren't allowed. Android needs them to show that HANNAH is listening, with a Stop button.", "NOTIFICATIONS_DENIED");
            return;
        }
        startService(call);
    }

    private void startService(PluginCall call) {
        Intent intent = HannahWakeService.command(getContext(), HannahWakeService.ACTION_START).putExtra(HannahWakeService.EXTRA_MODEL_URL, call.getString("modelUrl"));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve(new JSObject().put("state", "loading"));
        } catch (RuntimeException error) {
            call.reject("Android didn't allow HANNAH to start listening: " + error.getMessage(), "FAILED");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().startService(HannahWakeService.command(getContext(), HannahWakeService.ACTION_STOP));
        call.resolve(new JSObject().put("state", "off"));
    }

    /** A voice turn needs the microphone: release it (paused true), then take it back (paused false). */
    @PluginMethod
    public void pause(PluginCall call) {
        boolean paused = Boolean.TRUE.equals(call.getBoolean("paused", true));
        if (!"off".equals(HannahWakeService.state) && !"error".equals(HannahWakeService.state)) {
            getContext().startService(HannahWakeService.command(getContext(), paused ? HannahWakeService.ACTION_PAUSE : HannahWakeService.ACTION_RESUME));
        }
        call.resolve(new JSObject().put("paused", paused));
    }
}
