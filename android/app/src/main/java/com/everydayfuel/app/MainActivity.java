package com.everydayfuel.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GemmaPlugin.class);
        registerPlugin(VisionPlugin.class);
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
