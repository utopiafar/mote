package dev.mote.collector;

/** Test APK process only; Java keeps the fixture independent of the target APK's Kotlin runtime. */
public class ExternalFixtureActivity extends android.app.Activity {
    private int fixtureId(String name) {
        int id = getResources().getIdentifier("mote_fixture_" + name, "id", getPackageName());
        if (id == 0) throw new IllegalStateException("Missing generated fixture ID: " + name);
        return id;
    }
    private android.widget.TextView label(String name, String value) {
        android.widget.TextView view = new android.widget.TextView(this);
        view.setId(fixtureId(name)); view.setText(value); view.setTextSize(18f); view.setTextColor(android.graphics.Color.BLACK);
        return view;
    }
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        if (getIntent().getBooleanExtra("finishPageFixture", false)) { finish(); return; }
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        android.widget.LinearLayout content = new android.widget.LinearLayout(this);
        content.setOrientation(android.widget.LinearLayout.VERTICAL); content.setPadding(32,64,32,32);
        content.setBackgroundColor(android.graphics.Color.WHITE);
        content.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        String scene = getIntent().getStringExtra("pageScene");
        // API 35 draws behind system bars. Generated field fixtures stay fully visible
        // beneath them; the collector must keep its real overlay/privacy checks.
        if (scene!=null) content.setPadding(32,(int)(80f*getResources().getDisplayMetrics().density),32,32);
        if ("article".equals(scene) || "missingBody".equals(scene) || "private".equals(scene) || "deepArticle".equals(scene)) {
            content.setId(fixtureId("article"));
            content.addView(label("title", "Generated article title"));
            content.addView(label("author", "Generated author"));
            content.addView(label("url", "https://example.invalid/articles/generated"));
            if ("deepArticle".equals(scene)) {
                android.widget.LinearLayout parent = content;
                int wrappers = getIntent().getIntExtra("pageWrappers",24);
                if (wrappers<0 || wrappers>40) throw new IllegalArgumentException("Bounded generated tree only");
                for (int index=0;index<wrappers;index++) {
                    android.widget.LinearLayout child = new android.widget.LinearLayout(this);
                    child.setOrientation(android.widget.LinearLayout.VERTICAL);
                    child.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_YES);
                    parent.addView(child);parent=child;
                }
                parent.addView(label("body","Generated deeply nested original article body."));
            } else if (!"missingBody".equals(scene)) content.addView(label("body", "private".equals(scene) ? "GENERATED_BLOCKED_LITERAL" : "Generated original paragraph one.\nGenerated original paragraph two."));
        } else if ("product".equals(scene)) {
            content.setId(fixtureId("products"));
            for (int index=0;index<2;index++) {
                android.widget.LinearLayout card = new android.widget.LinearLayout(this);
                card.setId(fixtureId("card"));card.setOrientation(android.widget.LinearLayout.VERTICAL);card.setPadding(0,24,0,24);
                card.setImportantForAccessibility(android.view.View.IMPORTANT_FOR_ACCESSIBILITY_YES);
                card.addView(label("product_title", "Generated product " + index));
                card.addView(label("product_url", "https://example.invalid/items/" + index));
                card.addView(label("product_id", "generated-item-" + index));content.addView(card);
            }
        } else if ("empty".equals(scene)) {
            android.widget.TextView text = new android.widget.TextView(this);
            text.setText("Generated page without structured article or product fields");text.setTextSize(24f);text.setTextColor(android.graphics.Color.BLACK);content.addView(text);
        } else {
            for (int index=0;index<10;index++) {
                android.widget.TextView text = new android.widget.TextView(this);
                text.setText("MOTE GENERATED FIXTURE " + index + "\nOnly synthetic content. No personal data.");
                text.setTextSize(20f);text.setTextColor(android.graphics.Color.BLACK);content.addView(text);
            }
        }
        setContentView(content);
    }
    @Override public void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        if (intent.getBooleanExtra("finishPageFixture",false))finish();
    }
}
