// Generated from adapters/ui/builtin.json by scripts/ui-adapters.mjs.
import {uiRulesSchema} from './ui-page.js';
export const builtinUiRules=uiRulesSchema.parse([
  {
    "id": "wechat-web-android",
    "version": "1",
    "platform": "android",
    "appId": "com.tencent.mm",
    "activity": "com.tencent.mm.plugin.webview.ui.tools.MMWebViewUI",
    "required": [
      {
        "role": "android.webkit.WebView"
      }
    ],
    "select": {
      "role": "android.view.View"
    },
    "ancestor": {
      "role": "android.webkit.WebView"
    },
    "complete": false
  },
  {
    "id": "zhihu-content-android",
    "version": "1",
    "platform": "android",
    "appId": "com.zhihu.android",
    "activity": "com.zhihu.android.mixshortcontainer.MixShortContainerActivity",
    "required": [
      {
        "resourceId": "com.zhihu.android:id/view_content"
      }
    ],
    "select": {
      "role": "android.view.View"
    },
    "ancestor": {
      "resourceId": "com.zhihu.android:id/view_content"
    },
    "complete": false
  },
  {
    "id": "xhs-note-android",
    "version": "1",
    "platform": "android",
    "appId": "com.xingin.xhs",
    "activity": "com.xingin.matrix.notedetail.NoteDetailActivity",
    "required": [
      {
        "role": "android.widget.TextView"
      }
    ],
    "select": {
      "role": "android.widget.TextView"
    },
    "complete": false
  },
  {
    "id": "wechat-macos-visible",
    "version": "1",
    "platform": "macos",
    "appId": "com.tencent.xinWeChat",
    "required": [
      {
        "role": "AXStaticText"
      }
    ],
    "select": {
      "role": "AXStaticText"
    },
    "complete": false
  },
  {
    "id": "feishu-macos-visible",
    "version": "1",
    "platform": "macos",
    "appId": "com.electron.lark",
    "required": [
      {
        "role": "AXStaticText"
      }
    ],
    "select": {
      "role": "AXStaticText"
    },
    "complete": false
  },
  {
    "formatVersion": 2,
    "id": "wechat-article-android-8.0.78",
    "version": "1",
    "platform": "android",
    "appId": "com.tencent.mm",
    "appVersion": "8.0.78",
    "activity": "com.tencent.mm.plugin.brandservice.ui.timeline.preload.ui.TmplWebViewMMUI",
    "required": [
      {
        "resourceId": "js_article"
      }
    ],
    "region": {
      "resourceId": "js_article"
    },
    "kind": "article",
    "fields": {
      "title": {
        "select": {
          "resourceId": "activity-name",
          "role": "android.widget.TextView"
        },
        "required": true
      },
      "author": {
        "select": {
          "resourceId": "js_name",
          "role": "android.widget.Button"
        }
      },
      "body": {
        "select": {
          "role": "android.widget.TextView"
        },
        "ancestor": {
          "resourceId": "js_content"
        },
        "required": true
      }
    }
  },
  {
    "formatVersion": 2,
    "id": "taobao-products-android-10.66.22",
    "version": "1",
    "platform": "android",
    "appId": "com.taobao.taobao",
    "appVersion": "10.66.22",
    "activity": "com.taobao.tao.welcome.Welcome",
    "required": [
      {
        "resourceId": "com.taobao.taobao:id/rv_main_container_wrapper"
      }
    ],
    "region": {
      "resourceId": "com.taobao.taobao:id/rv_main_container_wrapper"
    },
    "repeat": {
      "role": "android.widget.FrameLayout"
    },
    "repeatParent": {
      "role": "androidx.recyclerview.widget.RecyclerView"
    },
    "kind": "product",
    "fields": {
      "title": {
        "select": {
          "role": "android.widget.TextView"
        },
        "childPath": [
          0,
          0,
          1,
          0
        ],
        "required": true
      }
    }
  }
]);
