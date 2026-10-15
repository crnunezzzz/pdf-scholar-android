package io.github.crnunezzzz.pdfscholar;

import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The device half of the Android platform layer (the JS half is
 * src/renderer/src/android-api.ts; see docs/ANDROID.md).
 *
 * Documents are addressed by their content:// URI. The bytes never cross the
 * JS bridge on the way in: a document is copied into the app's cache and the
 * WebView fetches that copy through Capacitor's local server. On the way out
 * (save, print, share) they arrive as base64, written once.
 */
@CapacitorPlugin(name = "PdfFiles")
public class PdfFilesPlugin extends Plugin {

    private static final String TAG = "PdfFiles";

    /** The document an «Open with» launch carried, until the renderer asks */
    private String pendingUri;

    /** The reader asked for fullscreen (immersive mode) */
    private boolean immersive = false;

    /** File copies run off the UI thread: an activity result arrives on it */
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        // Copies from earlier runs: every document is copied again when read
        deleteTree(new File(getContext().getCacheDir(), "docs"));
        deleteTree(new File(getContext().getCacheDir(), "out"));
        Intent launch = getActivity().getIntent();
        Uri uri = documentUri(launch);
        if (uri != null) {
            pendingUri = uri.toString();
            Log.i(TAG, "launch document " + pendingUri);
            // Handled: a recreated activity must not open it a second time
            launch.setAction(Intent.ACTION_MAIN);
        }
        // Back leaves fullscreen first. Otherwise it leaves the app running,
        // tabs and all, the way the home button does — rather than finishing
        // the activity
        getActivity()
            .getOnBackPressedDispatcher()
            .addCallback(
                getActivity(),
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        Log.i(TAG, "back pressed, immersive=" + immersive);
                        if (immersive) {
                            applyImmersive(false);
                            notifyListeners("fullscreenExit", new JSObject());
                            return;
                        }
                        getActivity().moveTaskToBack(true);
                    }
                }
            );
    }

    /** Coming back to the app (from home, a picker, the share sheet) can bring
     *  the bars back: fullscreen is the reader's choice until they leave it */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (immersive) applyImmersive(true);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri uri = documentUri(intent);
        if (uri == null) return;
        Log.i(TAG, "new intent document " + uri);
        JSObject event = new JSObject();
        event.put("uri", uri.toString());
        notifyListeners("openUri", event, true);
    }

    /** The PDF an ACTION_VIEW or ACTION_SEND intent hands us, or null */
    @SuppressWarnings("deprecation")
    private static Uri documentUri(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) return intent.getData();
        if (Intent.ACTION_SEND.equals(action)) return intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return null;
    }

    @PluginMethod
    public void takePendingUri(PluginCall call) {
        JSObject ret = new JSObject();
        if (pendingUri != null) ret.put("uri", pendingUri);
        Log.i(TAG, "pending document taken: " + pendingUri);
        pendingUri = null;
        call.resolve(ret);
    }

    // ---------- Fullscreen ----------

    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            applyImmersive(on);
            call.resolve();
        });
    }

    /** Status and navigation bars away; an edge swipe shows them over the page
     *  for a moment and they hide again on their own (sticky immersive) */
    private void applyImmersive(boolean on) {
        Log.i(TAG, "immersive " + on);
        immersive = on;
        android.view.Window window = getActivity().getWindow();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (on) {
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_DEFAULT);
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
        // The WebView's inset (Capacitor's SystemBars pads the decor view from
        // the insets) must follow at once, not at the next layout pass
        androidx.core.view.ViewCompat.requestApplyInsets(window.getDecorView());
    }

    // ---------- Reading ----------

    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/pdf");
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        Uri uri = resultUri(result);
        if (uri == null) {
            call.resolve(cancelled());
            return;
        }
        persistGrant(uri);
        io.execute(() -> resolveRead(call, uri));
    }

    @PluginMethod
    public void read(PluginCall call) {
        String raw = call.getString("uri");
        if (raw == null) {
            call.reject("uri missing");
            return;
        }
        io.execute(() -> resolveRead(call, Uri.parse(raw)));
    }

    private void resolveRead(PluginCall call, Uri uri) {
        try {
            File copy = new File(dir("docs"), hash(uri.toString()) + ".pdf");
            try (InputStream in = resolver().openInputStream(uri)) {
                if (in == null) throw new IOException("cannot open " + uri);
                copy(in, new FileOutputStream(copy));
            }
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            ret.put("name", displayName(uri));
            ret.put("file", copy.getAbsolutePath());
            ret.put("writable", canWrite(uri));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
        }
    }

    // ---------- Writing ----------

    @PluginMethod
    public void write(PluginCall call) {
        String raw = call.getString("uri");
        String data = call.getString("data");
        if (raw == null || data == null) {
            call.reject("uri or data missing");
            return;
        }
        io.execute(() -> {
            try {
                writeTo(Uri.parse(raw), Base64.decode(data, Base64.DEFAULT));
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
            }
        });
    }

    @PluginMethod
    public void create(PluginCall call) {
        String name = call.getString("name", "document.pdf");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "createResult");
    }

    @ActivityCallback
    private void createResult(PluginCall call, ActivityResult result) {
        Uri uri = resultUri(result);
        if (uri == null) {
            call.resolve(cancelled());
            return;
        }
        persistGrant(uri);
        String data = call.getString("data", "");
        io.execute(() -> {
            try {
                writeTo(uri, Base64.decode(data, Base64.DEFAULT));
                JSObject ret = new JSObject();
                ret.put("uri", uri.toString());
                ret.put("name", displayName(uri));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
            }
        });
    }

    private void writeTo(Uri uri, byte[] bytes) throws IOException {
        OutputStream out;
        try {
            // Truncate: a shorter document must not keep the old file's tail
            out = resolver().openOutputStream(uri, "wt");
        } catch (IllegalArgumentException | SecurityException e) {
            // Some providers know only plain "w" (which truncates there anyway)
            out = resolver().openOutputStream(uri, "w");
        }
        if (out == null) throw new IOException("cannot write " + uri);
        try (OutputStream o = out) {
            o.write(bytes);
            o.flush();
        }
    }

    // ---------- Handing bytes to the system ----------

    @PluginMethod
    public void share(PluginCall call) {
        try {
            File file = outFile(call.getString("name", "file"), call.getString("data", ""));
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(call.getString("mime", "application/octet-stream"));
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, file.getName());
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
        }
    }

    @PluginMethod
    public void print(PluginCall call) {
        try {
            String name = call.getString("name", "document.pdf");
            File file = outFile(name, call.getString("data", ""));
            getActivity().runOnUiThread(() -> {
                PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                pm.print(name, new FilePrintAdapter(file, name), new PrintAttributes.Builder().build());
                call.resolve();
            });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), e);
        }
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url missing");
            return;
        }
        try {
            Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(view);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no app for " + url, e);
        }
    }

    /** A PDF file handed to the print service as it is — the printer gets the
     *  document's own vector pages, not a picture of the screen */
    private static class FilePrintAdapter extends PrintDocumentAdapter {
        private final File file;
        private final String name;

        FilePrintAdapter(File file, String name) {
            this.file = file;
            this.name = name;
        }

        @Override
        public void onLayout(
            PrintAttributes oldAttributes,
            PrintAttributes newAttributes,
            CancellationSignal cancellationSignal,
            LayoutResultCallback callback,
            Bundle extras
        ) {
            if (cancellationSignal.isCanceled()) {
                callback.onLayoutCancelled();
                return;
            }
            PrintDocumentInfo info = new PrintDocumentInfo.Builder(name)
                .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                .build();
            callback.onLayoutFinished(info, true);
        }

        @Override
        public void onWrite(
            PageRange[] pages,
            ParcelFileDescriptor destination,
            CancellationSignal cancellationSignal,
            WriteResultCallback callback
        ) {
            try (InputStream in = new FileInputStream(file)) {
                copy(in, new FileOutputStream(destination.getFileDescriptor()));
                callback.onWriteFinished(new PageRange[] { PageRange.ALL_PAGES });
            } catch (IOException e) {
                callback.onWriteFailed(e.getMessage());
            }
        }
    }

    // ---------- Helpers ----------

    private ContentResolver resolver() {
        return getContext().getContentResolver();
    }

    private static Uri resultUri(ActivityResult result) {
        if (result.getResultCode() != android.app.Activity.RESULT_OK) return null;
        Intent data = result.getData();
        return data != null ? data.getData() : null;
    }

    private static JSObject cancelled() {
        JSObject ret = new JSObject();
        ret.put("cancelled", true);
        return ret;
    }

    /** Keep the grant across restarts, so a recent reopens and a save goes back
     *  over the same document. Read+write when offered, read alone otherwise. */
    private void persistGrant(Uri uri) {
        try {
            resolver().takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (SecurityException e) {
            try {
                resolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // A one-off grant (another app's «Open with»): readable this run
            }
        }
    }

    private boolean canWrite(Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).canWrite();
        return (
            getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
        );
    }

    private String displayName(Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = resolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    String name = c.getString(0);
                    if (name != null && !name.isEmpty()) return name;
                }
            } catch (Exception ignored) {
                // Fall through to the URI's last segment
            }
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "document.pdf";
    }

    /** Bytes from the renderer, written under their own name for another app */
    private File outFile(String name, String base64) throws IOException {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (safe.isEmpty()) safe = "file";
        File file = new File(dir("out"), safe);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(Base64.decode(base64, Base64.DEFAULT));
        }
        return file;
    }

    private File dir(String name) throws IOException {
        File d = new File(getContext().getCacheDir(), name);
        if (!d.isDirectory() && !d.mkdirs()) throw new IOException("cannot create " + d);
        return d;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        try (OutputStream o = out) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
        }
    }

    private static String hash(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes("UTF-8"));
            StringBuilder hex = new StringBuilder();
            for (byte b : d) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
