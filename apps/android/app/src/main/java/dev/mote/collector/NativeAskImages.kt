package dev.mote.collector

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** Private picker references only. Uploads start solely from selection or explicit Retry. */
internal object NativeAskImages {
    fun pending(state:JSONObject)=state.optJSONArray("imageUploads") ?: JSONArray()
    fun count(state:JSONObject)=(state.optJSONArray("attachments")?.length() ?: 0)+pending(state).length()
    fun recover(state:JSONObject) { val rows=pending(state);for(i in 0 until rows.length())if(rows.getJSONObject(i).optString("status")=="uploading")rows.getJSONObject(i).put("status","unconfirmed") }
    fun clearReferences(state:JSONObject) {
        state.remove("imageUploads")
        state.optJSONArray("attachments")?.let { rows -> for(i in 0 until rows.length()){rows.getJSONObject(i).remove("uri");rows.getJSONObject(i).remove("preview")} }
    }
    fun stage(state:JSONObject,uris:List<Uri>)=stageReferences(state,uris.map(Uri::toString))
    fun stageReferences(state:JSONObject,references:List<String>):List<JSONObject> {
        require(count(state)+references.size<=4) { MoteI18n.text("最多添加 4 张图片") }
        val rows=JSONArray(pending(state).toString())
        val selected=references.map { reference ->
            require(java.net.URI(reference).scheme=="content") { MoteI18n.text("请选择 PNG、JPEG 或 WebP 图片。") }
            JSONObject().put("selectionId",UUID.randomUUID().toString()).put("uri",reference).put("name",MoteI18n.text("图片")).put("status","uploading")
        }
        selected.forEach(rows::put)
        state.put("imageUploads",rows);return selected
    }
    fun remove(state:JSONObject,id:String) { val rows=pending(state);state.put("imageUploads",JSONArray((0 until rows.length()).map(rows::getJSONObject).filter { it.getString("selectionId")!=id })) }
    fun merge(state:JSONObject,result:JSONObject) {
        val id=result.getString("selectionId");val rows=pending(state)
        val index=(0 until rows.length()).firstOrNull { rows.getJSONObject(it).getString("selectionId")==id } ?: return
        if(NativeAskRunState.busy(state))return
        if(result.optString("status")=="ready") {
            val attachments=state.optJSONArray("attachments") ?: JSONArray()
            if((0 until attachments.length()).none { attachments.getJSONObject(it).getString("id")==result.getString("id") })attachments.put(JSONObject(result.toString()).apply { remove("selectionId");remove("status");remove("error") })
            state.put("attachments",attachments);remove(state,id)
        } else rows.put(index,JSONObject(result.toString()))
    }
    fun upload(resolver:ContentResolver,selection:JSONObject,client:CentralClient,directory:File,deviceId:String,resolveTime:(String)->Long,progress:(Int,Int)->Unit):JSONObject {
        val result=JSONObject(selection.toString())
        val spool=File(directory,"attachment-"+UUID.randomUUID()+".tmp")
        try {
            val uri=Uri.parse(selection.getString("uri"));val mime=resolver.getType(uri).orEmpty()
            require(mime in listOf("image/png","image/jpeg","image/webp")) { MoteI18n.text("请选择 PNG、JPEG 或 WebP 图片。") }
            val name=resolver.query(uri,arrayOf(OpenableColumns.DISPLAY_NAME),null,null,null)?.use { if(it.moveToFirst())it.getString(0) else null } ?: MoteI18n.text("图片")
            result.put("name",name)
            directory.mkdirs()
            resolver.openInputStream(uri)!!.use { input -> spool.outputStream().use { output ->
                val buffer=ByteArray(65536);var total=0
                while(true){val n=input.read(buffer);if(n<0)break;total+=n;require(total<=8*1024*1024) { MoteI18n.text("聊天图片仅支持 PNG、JPEG、WebP，每张不超过 8 MiB。") };output.write(buffer,0,n)}
            } }
            val bounds=BitmapFactory.Options().apply { inJustDecodeBounds=true };BitmapFactory.decodeFile(spool.path,bounds)
            require(bounds.outWidth>0 && bounds.outHeight>0) { MoteI18n.text("请选择 PNG、JPEG 或 WebP 图片。") }
            var sample=1;while(maxOf(bounds.outWidth,bounds.outHeight)/sample>160)sample*=2
            BitmapFactory.decodeFile(spool.path,BitmapFactory.Options().apply { inSampleSize=sample })?.let { bitmap ->
                try { val bytes=ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.JPEG,75,it) }.toByteArray();result.put("preview",Base64.encodeToString(bytes,Base64.NO_WRAP)) } finally { bitmap.recycle() }
            }
            val id=CentralAttachments.upload(client,spool,name,mime,deviceId,resolveTime=resolveTime,progress=progress)
            result.put("id",id).put("status","ready");result.remove("error")
        } catch(error:Exception) {
            if(error is CentralFailure && error.status in setOf(401,403))throw error
            result.put("status",if(error is IllegalArgumentException || error is SecurityException)"failed" else "unconfirmed")
                .put("error",error.message.orEmpty())
        } finally { spool.delete() }
        return result
    }
}
