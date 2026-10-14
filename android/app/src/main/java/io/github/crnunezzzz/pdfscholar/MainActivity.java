package io.github.crnunezzzz.pdfscholar;

import android.os.Bundle;
import android.view.KeyEvent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (documents, printing, «Open with») must be
        // registered before the bridge starts
        registerPlugin(PdfFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * The Back KEY goes to the app's own Back handling (PdfFilesPlugin: leave
     * fullscreen, else to the background) before the WebView sees it. With a
     * button on the page focused, the WebView took the key and it never came
     * back unhandled — Back did nothing at all (the emulated tablet, focus on
     * the toolbar button just tapped). The gesture Back never was a key and
     * already reaches the dispatcher; an open keyboard still gets the first
     * Back, since the input method sees keys before the activity.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) {
                getOnBackPressedDispatcher().onBackPressed();
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
