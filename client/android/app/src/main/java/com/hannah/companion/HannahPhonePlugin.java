package com.hannah.companion;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * HANNAH Phone Bridge on Android: the phone's own dialer and messaging app do
 * the cellular work, after the person taps Call or Send.
 *
 * - dial opens the dialer with the number filled in (ACTION_DIAL). It doesn't
 *   place the call, so no CALL_PHONE permission is needed.
 * - composeSms opens the default messaging app with the recipient and text
 *   filled in (ACTION_SENDTO, smsto:). Nothing is sent until the person taps
 *   Send, so no SEND_SMS permission is needed (Google Play restricts it).
 * - findContacts searches contacts on the phone, with the READ_CONTACTS
 *   permission the person grants, and returns only the matching names and
 *   numbers; the contact book never leaves the phone.
 *
 * Every request is checked here again, independently of the web layer: the
 * number's shape, no * or # codes, and no emergency numbers.
 */
@CapacitorPlugin(
    name = "HannahPhone",
    permissions = { @Permission(alias = "contacts", strings = { Manifest.permission.READ_CONTACTS }) }
)
public class HannahPhonePlugin extends Plugin {

    private static final Pattern NUMBER = Pattern.compile("^\\+?\\d{3,17}$");
    private static final Set<String> EMERGENCY = new HashSet<>(Arrays.asList(
        "000", "08", "100", "101", "102", "103", "108", "110", "112", "113", "115", "118", "119", "122", "15", "17", "18", "911", "999", "1122", "1091", "1098", "181"));

    /** Null if the number may be used, otherwise why not. */
    static String refuse(String number) {
        if (number == null || !NUMBER.matcher(number).matches()) return "That isn't a phone number.";
        String digits = number.replace("+", "");
        if (EMERGENCY.contains(digits)) return "HANNAH doesn't call or text emergency numbers.";
        if (digits.length() <= 5) {
            for (String emergency : EMERGENCY) {
                if (emergency.length() >= 3 && digits.endsWith(emergency)) return "HANNAH doesn't call or text emergency numbers.";
            }
        }
        return null;
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("platform", "android");
        result.put("canDial", new Intent(Intent.ACTION_DIAL, Uri.parse("tel:123")).resolveActivity(getContext().getPackageManager()) != null);
        result.put("canSms", new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:123")).resolveActivity(getContext().getPackageManager()) != null);
        result.put("contactsPermission", getPermissionState("contacts").toString().toLowerCase());
        call.resolve(result);
    }

    @PluginMethod
    public void dial(PluginCall call) {
        String number = call.getString("number");
        String refused = refuse(number);
        if (refused != null) {
            call.reject(refused, "REFUSED");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number)));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("result", "opened");
            call.resolve(result);
        } catch (ActivityNotFoundException error) {
            call.reject("This phone has no dialer app.", "NO_APP");
        }
    }

    @PluginMethod
    public void composeSms(PluginCall call) {
        String number = call.getString("number");
        String body = call.getString("body", "");
        String refused = refuse(number);
        if (refused != null) {
            call.reject(refused, "REFUSED");
            return;
        }
        if (body == null || body.isEmpty() || body.length() > 1000) {
            call.reject("The message must be 1 to 1000 characters.", "REFUSED");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(number)));
        intent.putExtra("sms_body", body);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (intent.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("This phone has no messaging app.", "NO_APP");
            return;
        }
        getContext().startActivity(intent);
        // Android doesn't tell apps whether the person then sent the message.
        JSObject result = new JSObject();
        result.put("result", "opened");
        call.resolve(result);
    }

    @PluginMethod
    public void findContacts(PluginCall call) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAlias("contacts", call, "contactsPermissionAnswered");
            return;
        }
        searchContacts(call);
    }

    @PermissionCallback
    private void contactsPermissionAnswered(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) searchContacts(call);
        else call.reject("Contacts permission wasn't given, so HANNAH can't look up names on this phone.", "PERMISSION_DENIED");
    }

    private void searchContacts(PluginCall call) {
        String query = call.getString("query", "").trim();
        if (query.length() < 2 || query.length() > 80) {
            call.reject("Give at least two letters of the name.", "REFUSED");
            return;
        }
        String[] projection = {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.TYPE,
            ContactsContract.CommonDataKinds.Phone.LABEL,
        };
        String like = "%" + query.replace("%", "").replace("_", "") + "%";
        Map<String, JSArray> byName = new LinkedHashMap<>();
        try (Cursor cursor = getContext().getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                projection,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?",
                new String[] { like },
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC")) {
            while (cursor != null && cursor.moveToNext() && byName.size() <= 10) {
                String name = cursor.getString(0);
                String number = cursor.getString(1);
                if (name == null || number == null) continue;
                CharSequence label = ContactsContract.CommonDataKinds.Phone.getTypeLabel(getContext().getResources(), cursor.getInt(2), cursor.getString(3));
                JSObject entry = new JSObject();
                entry.put("label", label == null ? null : label.toString());
                entry.put("number", number);
                byName.computeIfAbsent(name, key -> new JSArray());
                if (byName.get(name).length() < 6) byName.get(name).put(entry);
            }
        } catch (SecurityException error) {
            call.reject("Contacts permission wasn't given.", "PERMISSION_DENIED");
            return;
        }
        JSArray matches = new JSArray();
        int count = 0;
        for (Map.Entry<String, JSArray> entry : byName.entrySet()) {
            if (count++ >= 10) break;
            JSObject match = new JSObject();
            match.put("name", entry.getKey());
            match.put("numbers", entry.getValue());
            matches.put(match);
        }
        JSObject result = new JSObject();
        result.put("matches", matches);
        call.resolve(result);
    }
}
