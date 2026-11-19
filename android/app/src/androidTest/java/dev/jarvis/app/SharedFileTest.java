package dev.jarvis.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.net.Uri;
import androidx.core.content.FileProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.DataInputStream;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SharedFileTest {
    @Test
    public void inboxAttachmentCanBeReadThroughTheAppsFileProvider() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("dev.jarvis.app", context.getPackageName());
        File inbox = new File(context.getFilesDir(), "inbox");
        assertTrue(inbox.isDirectory() || inbox.mkdirs());
        File file = File.createTempFile("attachment-", ".txt", inbox);
        byte[] original = new byte[] {65, 66, 67};
        try {
            try (FileOutputStream output = new FileOutputStream(file)) {
                output.write(original);
            }
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            try (DataInputStream input = new DataInputStream(context.getContentResolver().openInputStream(uri))) {
                byte[] received = new byte[original.length];
                input.readFully(received);
                assertArrayEquals(original, received);
                assertEquals(-1, input.read());
            }
        } finally {
            assertTrue(file.delete());
        }
    }
}
