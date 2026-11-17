package com.swiftserve.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String PREFS = "swiftserve";
    private static final String JOBS_KEY = "local_jobs";
    private static final String API_KEY = "api_url";
    private static final String KEY_ALIAS = "swiftserve_session_key";
    private static final int INK = Color.rgb(20, 44, 39);
    private static final int GREEN = Color.rgb(22, 111, 83);
    private static final int MUTED = Color.rgb(102, 117, 112);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private LinearLayout jobsList;
    private EditText apiUrl, emailInput, passwordInput, fullNameInput, businessNameInput, description, area;
    private Spinner service;
    private TextView connectionStatus;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(244, 248, 245));
        getWindow().setNavigationBarColor(Color.rgb(244, 248, 245));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(20), dp(28), dp(20), dp(32));
        page.setBackgroundColor(Color.rgb(244, 248, 245));
        scroll.addView(page);
        setContentView(scroll);

        TextView brand = text("SWIFTSERVE  /  BUSINESS", 12, GREEN, true);
        page.addView(brand);
        TextView title = text("Service requests", 28, INK, true);
        LinearLayout.LayoutParams titleParams = params(-1, -2);
        titleParams.topMargin = dp(8);
        page.addView(title, titleParams);
        TextView intro = text("Keep every customer job moving.", 15, MUTED, false);
        LinearLayout.LayoutParams introParams = params(-1, -2);
        introParams.topMargin = dp(4);
        page.addView(intro, introParams);

        connectionStatus = text("", 13, MUTED, false);
        LinearLayout.LayoutParams statusParams = params(-1, -2);
        statusParams.topMargin = dp(18);
        page.addView(connectionStatus, statusParams);

        apiUrl = new EditText(this);
        apiUrl.setSingleLine(true);
        apiUrl.setText(getPreferences(0).getString(API_KEY, ""));
        apiUrl.setHint("API address (optional, https://...)");
        apiUrl.setTextSize(14);
        page.addView(apiUrl, params(-1, dp(52)));
        Button connect = button("Save API address");
        page.addView(connect, params(-1, dp(48)));
        connect.setOnClickListener(v -> {
            String value = apiUrl.getText().toString().trim().replaceAll("/+$", "");
            if (!value.isEmpty()) {
                try {
                    URL parsed = new URL(value);
                    if (!"https".equalsIgnoreCase(parsed.getProtocol()) ||
                            parsed.getHost().isEmpty() || parsed.getUserInfo() != null) {
                        toast("Enter a valid HTTPS API address.");
                        return;
                    }
                } catch (Exception error) {
                    toast("Enter a valid HTTPS API address.");
                    return;
                }
            }
            getPreferences(0).edit().putString(API_KEY, value).apply();
            updateConnection();
            loadJobs();
        });

        section(page, "Business account");
        emailInput = input("Business email", true);
        emailInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        page.addView(emailInput, params(-1, dp(52)));

        passwordInput = input("Password (minimum 12 characters)", true);
        passwordInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        page.addView(passwordInput, params(-1, dp(52)));

        fullNameInput = input("Your full name (for new accounts)", true);
        page.addView(fullNameInput, params(-1, dp(52)));

        businessNameInput = input("Business name (for new accounts)", true);
        page.addView(businessNameInput, params(-1, dp(52)));

        Button signIn = button("Sign in");
        page.addView(signIn, params(-1, dp(48)));
        signIn.setOnClickListener(v -> authenticate(false));

        Button createAccount = button("Create business account");
        page.addView(createAccount, params(-1, dp(48)));
        createAccount.setOnClickListener(v -> authenticate(true));

        Button signOut = button("Sign out");
        page.addView(signOut, params(-1, dp(48)));
        signOut.setOnClickListener(v -> signOut());

        section(page, "New request");
        service = new Spinner(this);
        String[] services = {"cleaning", "laundry", "electrical", "plumbing", "ac-repair", "appliance-repair", "errand"};
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, services);
        service.setAdapter(adapter);
        page.addView(service, params(-1, dp(48)));

        description = input("Describe the job (at least 10 characters)", false);
        page.addView(description, params(-1, dp(54)));
        area = input("Area or neighborhood", true);
        page.addView(area, params(-1, dp(54)));
        Button add = button("Add service request");
        LinearLayout.LayoutParams addParams = params(-1, dp(50));
        addParams.topMargin = dp(8);
        page.addView(add, addParams);
        add.setOnClickListener(v -> createJob());

        section(page, "Requests");
        Button refresh = button("Refresh requests");
        page.addView(refresh, params(-1, dp(46)));
        refresh.setOnClickListener(v -> loadJobs());
        jobsList = new LinearLayout(this);
        jobsList.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams listParams = params(-1, -2);
        listParams.topMargin = dp(10);
        page.addView(jobsList, listParams);
        updateConnection();
        loadJobs();
    }

    private void updateConnection() {
        String base = getPreferences(0).getString(API_KEY, "");
        String token = getAccessToken();
        String businessName = getPreferences(0).getString("business_name", "");
        if (base.isEmpty()) {
            connectionStatus.setText("On-device mode · requests stay on this phone");
        } else if (token.isEmpty()) {
            connectionStatus.setText("API configured · sign in to your business account");
        } else {
            connectionStatus.setText("Signed in · " + (businessName.isEmpty() ? "business workspace" : businessName));
        }
    }

    private void authenticate(boolean createAccount) {
        String base = getPreferences(0).getString(API_KEY, "");
        if (base.isEmpty()) {
            toast("Save your HTTPS API address first.");
            return;
        }

        String email = emailInput.getText().toString().trim();
        String password = passwordInput.getText().toString();
        String fullName = fullNameInput.getText().toString().trim();
        String businessName = businessNameInput.getText().toString().trim();

        if (email.isEmpty() || password.isEmpty()) {
            toast("Enter your business email and password.");
            return;
        }
        if (createAccount && (fullName.length() < 2 || businessName.length() < 2 || password.length() < 12)) {
            toast("For registration, enter your name, business name and a password of at least 12 characters.");
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            payload.put("email", email);
            payload.put("password", password);
            if (createAccount) {
                payload.put("fullName", fullName);
                payload.put("accountType", "business");
                payload.put("businessName", businessName);
            }
        } catch (JSONException ignored) {
            toast("Could not prepare the account request.");
            return;
        }

        String path = createAccount ? "/api/v1/auth/register" : "/api/v1/auth/login";
        perform(() -> api("POST", path, payload), result -> {
            JSONObject data = result.optJSONObject("data");
            JSONArray businesses = data == null ? null : data.optJSONArray("businesses");
            JSONObject firstBusiness = businesses == null || businesses.length() == 0
                    ? null : businesses.optJSONObject(0);
            if (data == null || firstBusiness == null || data.optString("accessToken").isEmpty()) {
                toast("This account has no business workspace. Sign in with a business account.");
                return;
            }

            try {
                saveSession(
                        data.optString("accessToken"),
                        firstBusiness.optString("id"),
                        firstBusiness.optString("name")
                );
            } catch (Exception error) {
                toast("Could not securely save the sign-in session on this device.");
                return;
            }
            passwordInput.setText("");
            updateConnection();
            loadJobs();
            toast(createAccount ? "Business account created." : "Signed in successfully.");
        });
    }

    private void signOut() {
        String token = getAccessToken();
        if (token.isEmpty()) {
            clearLocalSession();
            toast("Signed out on this device.");
            return;
        }
        perform(() -> api("POST", "/api/v1/auth/logout", new JSONObject()), result -> {
            clearLocalSession();
            updateConnection();
            if (jobsList != null) jobsList.removeAllViews();
            toast("Signed out successfully.");
        });
    }

    private void clearLocalSession() {
        getPreferences(0).edit()
                .remove("encrypted_access_token")
                .remove("access_token_iv")
                .remove("business_id")
                .remove("business_name")
                .apply();
        updateConnection();
    }

    private boolean hasBusinessSession() {
        return !getAccessToken().isEmpty()
                && !getPreferences(0).getString("business_id", "").isEmpty();
    }

    private void createJob() {
        String details = description.getText().toString().trim();
        String neighborhood = area.getText().toString().trim();
        if (details.length() < 10 || neighborhood.length() < 2) {
            Toast.makeText(this, "Add a longer description and an area.", Toast.LENGTH_SHORT).show();
            return;
        }
        JSONObject job = new JSONObject();
        try {
            job.put("service", service.getSelectedItem().toString());
            job.put("description", details);
            job.put("area", neighborhood);
            job.put("status", "pending");
        } catch (JSONException ignored) { return; }

        String base = getPreferences(0).getString(API_KEY, "");
        if (!base.isEmpty() && !hasBusinessSession()) {
            toast("Sign in to your business account before sending requests.");
            return;
        }
        if (base.isEmpty()) {
            JSONArray list = localJobs();
            try {
                job.put("id", UUID.randomUUID().toString());
                job.put("createdAt", System.currentTimeMillis());
                list.put(job);
                saveLocalJobs(list);
                description.setText("");
                area.setText("");
                render(list);
            } catch (JSONException ignored) { }
            return;
        }
        perform(() -> api("POST", "/api/v1/jobs", job), result -> {
            description.setText("");
            area.setText("");
            loadJobs();
            toast("Request added.");
        });
    }

    private void loadJobs() {
        String base = getPreferences(0).getString(API_KEY, "");
        if (base.isEmpty()) {
            render(localJobs());
            return;
        }
        if (!hasBusinessSession()) {
            jobsList.removeAllViews();
            TextView signInMessage = text("Sign in to your business account to view requests.", 14, MUTED, false);
            signInMessage.setPadding(dp(4), dp(18), dp(4), dp(18));
            jobsList.addView(signInMessage);
            return;
        }
        perform(() -> api("GET", "/api/v1/jobs", null).optJSONArray("data"), result -> {
            if (result instanceof JSONArray) render((JSONArray) result);
        });
    }

    private void changeStatus(JSONObject job) {
        String current = job.optString("status", "pending");
        String next = current.equals("pending") ? "accepted" : current.equals("accepted") ? "completed" : "pending";
        String base = getPreferences(0).getString(API_KEY, "");
        if (base.isEmpty()) {
            updateLocal(job.optString("id"), "status", next);
            render(localJobs());
            return;
        }
        JSONObject patch = new JSONObject();
        try { patch.put("status", next); } catch (JSONException ignored) { return; }
        perform(() -> api("PATCH", "/api/v1/jobs/" + job.optString("id"), patch), result -> loadJobs());
    }

    private void removeJob(JSONObject job) {
        new AlertDialog.Builder(this)
                .setTitle("Delete request?")
                .setMessage("This will permanently remove this request.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Delete", (dialog, which) -> {
                    String base = getPreferences(0).getString(API_KEY, "");
                    if (base.isEmpty()) {
                        JSONArray old = localJobs();
                        JSONArray kept = new JSONArray();
                        for (int i = 0; i < old.length(); i++) {
                            JSONObject item = old.optJSONObject(i);
                            if (item != null && !item.optString("id").equals(job.optString("id"))) kept.put(item);
                        }
                        saveLocalJobs(kept);
                        render(kept);
                    } else {
                        perform(() -> api("DELETE", "/api/v1/jobs/" + job.optString("id"), null), result -> loadJobs());
                    }
                }).show();
    }

    private void render(JSONArray jobs) {
        jobsList.removeAllViews();
        if (jobs == null || jobs.length() == 0) {
            TextView empty = text("No requests yet. Add one above to get started.", 14, MUTED, false);
            empty.setPadding(dp(4), dp(18), dp(4), dp(18));
            jobsList.addView(empty);
            return;
        }
        for (int i = jobs.length() - 1; i >= 0; i--) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) continue;
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(16), dp(14), dp(16), dp(14));
            card.setBackgroundColor(Color.WHITE);
            LinearLayout.LayoutParams cardParams = params(-1, -2);
            cardParams.bottomMargin = dp(10);
            jobsList.addView(card, cardParams);

            TextView heading = text(job.optString("service", "Service").replace('-', ' '), 17, INK, true);
            card.addView(heading);
            TextView summary = text(job.optString("description", ""), 14, MUTED, false);
            LinearLayout.LayoutParams sumParams = params(-1, -2);
            sumParams.topMargin = dp(6);
            card.addView(summary, sumParams);
            TextView meta = text(job.optString("area", "") + "  ·  " + job.optString("status", "pending"), 13, GREEN, true);
            LinearLayout.LayoutParams metaParams = params(-1, -2);
            metaParams.topMargin = dp(8);
            card.addView(meta, metaParams);

            LinearLayout actions = new LinearLayout(this);
            actions.setOrientation(LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams actionsParams = params(-1, dp(44));
            actionsParams.topMargin = dp(10);
            card.addView(actions, actionsParams);
            String status = job.optString("status", "pending");
            if (status.equals("pending") || status.equals("accepted")) {
                Button update = button(nextLabel(status));
                actions.addView(update, new LinearLayout.LayoutParams(0, -1, 1));
                update.setOnClickListener(v -> changeStatus(job));
            }
            Button delete = button("Delete");
            LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(dp(100), -1);
            deleteParams.leftMargin = dp(8);
            actions.addView(delete, deleteParams);
            delete.setOnClickListener(v -> removeJob(job));
        }
    }

    private String nextLabel(String status) {
        if (status.equals("pending")) return "Accept";
        if (status.equals("accepted")) return "Complete";
        return "Reopen";
    }

    private JSONArray localJobs() {
        String raw = getPreferences(0).getString(JOBS_KEY, "[]");
        try { return new JSONArray(raw); } catch (JSONException error) { return new JSONArray(); }
    }

    private void saveLocalJobs(JSONArray jobs) {
        getPreferences(0).edit().putString(JOBS_KEY, jobs.toString()).apply();
    }

    private void updateLocal(String id, String key, String value) {
        JSONArray old = localJobs();
        for (int i = 0; i < old.length(); i++) {
            JSONObject item = old.optJSONObject(i);
            if (item != null && item.optString("id").equals(id)) {
                try { item.put(key, value); } catch (JSONException ignored) { }
            }
        }
        saveLocalJobs(old);
    }

    private interface NetworkCall { Object run() throws Exception; }
    private interface Success { void accept(Object value); }

    private void perform(NetworkCall call, Success success) {
        Toast.makeText(this, "Working…", Toast.LENGTH_SHORT).show();
        worker.execute(() -> {
            try {
                Object value = call.run();
                runOnUiThread(() -> success.accept(value));
            } catch (Exception error) {
                String message = error.getMessage() == null ? "Could not reach the API." : error.getMessage();
                runOnUiThread(() -> {
                    if (message.contains("API request failed (401)")) {
                        clearLocalSession();
                        if (jobsList != null) jobsList.removeAllViews();
                        toast("Your session has expired. Please sign in again.");
                    } else {
                        toast(message);
                    }
                });
            }
        });
    }

    private JSONObject api(String method, String path, JSONObject body) throws Exception {
        String base = getPreferences(0).getString(API_KEY, "");
        HttpURLConnection conn = (HttpURLConnection) new URL(base + path).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        conn.setRequestProperty("Accept", "application/json");
        String accessToken = getAccessToken();
        String businessId = getPreferences(0).getString("business_id", "");
        if (!accessToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + accessToken);
        }
        if (!businessId.isEmpty()) {
            conn.setRequestProperty("X-SwiftServe-Business-Id", businessId);
        }
        if (body != null) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        int status = conn.getResponseCode();
        if (status < 200 || status >= 300) {
            InputStream err = conn.getErrorStream();
            if (err != null) err.close();
            conn.disconnect();
            throw new IllegalStateException("API request failed (" + status + ").");
        }
        InputStream stream = status == 204 ? null : conn.getInputStream();
        StringBuilder response = new StringBuilder();
        if (stream != null) try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) response.append(line);
        }
        conn.disconnect();
        return response.length() == 0 ? new JSONObject() : new JSONObject(response.toString());
    }


    private void saveSession(String token, String businessId, String businessName) throws Exception {
        java.security.KeyStore keyStore = java.security.KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance(
                    KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build());
            generator.generateKey();
        }

        javax.crypto.SecretKey secretKey = (javax.crypto.SecretKey) keyStore.getKey(KEY_ALIAS, null);
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, secretKey);
        byte[] encrypted = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));

        getPreferences(0).edit()
                .putString("encrypted_access_token", Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString("access_token_iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putString("business_id", businessId)
                .putString("business_name", businessName)
                .apply();
    }

    private String getAccessToken() {
        String encryptedValue = getPreferences(0).getString("encrypted_access_token", "");
        String ivValue = getPreferences(0).getString("access_token_iv", "");
        if (encryptedValue.isEmpty() || ivValue.isEmpty()) return "";

        try {
            java.security.KeyStore keyStore = java.security.KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (!keyStore.containsAlias(KEY_ALIAS)) return "";

            javax.crypto.SecretKey secretKey = (javax.crypto.SecretKey) keyStore.getKey(KEY_ALIAS, null);
            byte[] encrypted = Base64.decode(encryptedValue, Base64.NO_WRAP);
            byte[] iv = Base64.decode(ivValue, Base64.NO_WRAP);
            javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(javax.crypto.Cipher.DECRYPT_MODE, secretKey, new javax.crypto.spec.GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception error) {
            getPreferences(0).edit()
                    .remove("encrypted_access_token")
                    .remove("access_token_iv")
                    .remove("business_id")
                    .remove("business_name")
                    .apply();
            return "";
        }
    }

    private EditText input(String hint, boolean singleLine) {
        EditText edit = new EditText(this);
        edit.setHint(hint);
        edit.setTextSize(14);
        edit.setSingleLine(singleLine);
        return edit;
    }

    private void section(LinearLayout parent, String label) {
        TextView heading = text(label, 18, INK, true);
        LinearLayout.LayoutParams p = params(-1, -2);
        p.topMargin = dp(24);
        p.bottomMargin = dp(6);
        parent.addView(heading, p);
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(null, Typeface.BOLD);
        return view;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(13);
        button.setTextColor(Color.WHITE);
        button.setAllCaps(false);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(GREEN));
        return button;
    }

    private LinearLayout.LayoutParams params(int width, int height) {
        return new LinearLayout.LayoutParams(width, height);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    @Override protected void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }
}
