package dev.jarvis.app;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.InputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
    private static final ArrayList<JSObject> shares = new ArrayList<>();
    private final java.util.concurrent.ExecutorService imports = Executors.newSingleThreadExecutor();

    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JarvisLlmPlugin.class);
        registerPlugin(JarvisModelsPlugin.class);
        registerPlugin(JarvisSpeechPlugin.class);
        registerPlugin(JarvisFilesPlugin.class);
        super.onCreate(savedInstanceState);
        receive(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        receive(intent);
    }

    public static synchronized JSArray takeShares() {
        JSArray files = new JSArray();
        for (JSObject item : shares) files.put(item);
        shares.clear();
        return files;
    }

    private void receive(Intent intent) {
        if (intent == null) return;
        ArrayList<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> items = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (items != null) uris.addAll(items);
        }
        if (!uris.isEmpty()) intent.setAction(null);
        for (Uri uri : uris) {
            if (!"content".equals(uri.getScheme())) continue;
            imports.execute(() -> {
                File target = null;
                try {
                    String name = "file";
                    try (android.database.Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
                        if (cursor != null && cursor.moveToFirst()) {
                            int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                            if (index >= 0) name = cursor.getString(index);
                        }
                    }
                    name = new File(name).getName().replaceAll("[^\\p{L}\\p{N}._-]", "_");
                    if (name.length() > 120) name = name.substring(0, 120);
                    File inbox = new File(getFilesDir(), "inbox");
                    inbox.mkdirs();
                    target = new File(inbox, UUID.randomUUID() + "-" + name);
                    long size = 0;
                    try (InputStream input = getContentResolver().openInputStream(uri);
                         FileOutputStream output = new FileOutputStream(target)) {
                        byte[] buffer = new byte[131072];
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            size += count;
                            if (size > 1024L * 1024 * 1024) throw new java.io.IOException("File too large");
                            output.write(buffer, 0, count);
                        }
                    }
                    synchronized (MainActivity.class) {
                        shares.add(new JSObject().put("path", target.getPath()).put("name", name).put("size", size));
                    }
                } catch (Exception e) {
                    if (target != null) target.delete();
                    android.util.Log.w("JARVIS", "Could not import shared file", e);
                }
            });
        }
    }
}
