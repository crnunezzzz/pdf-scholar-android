package io.github.crnunezzzz.pdfscholar;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (documents, printing, «Open with») must be
        // registered before the bridge starts
        registerPlugin(PdfFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
