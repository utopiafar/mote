package dev.mote.collector

import org.json.JSONArray
import org.json.JSONObject

/** Bounded named observations. Descriptions are supplied only by UiPageReader's safe leaf gate. */
internal object NamedPageRules {
    private val fieldName = Regex("[a-z][a-z0-9_]{0,99}")
    fun validate(rule: JSONObject) {
        require(rule.keys().asSequence().all { it in setOf("formatVersion","id","version","platform","appId","appVersion","activity","kind","region","repeat","repeatParent","repeatSubtreeHash","required","fields") })
        for (key in listOf("id","version","platform","appId","appVersion","kind")) require(rule.has(key) && rule.get(key) is String && rule.getString(key).isNotBlank() && rule.getString(key).length <= if(key=="kind") 100 else 300)
        require(rule.getInt("formatVersion")==3 && rule.getDouble("formatVersion")==3.0 && rule.getString("platform") in setOf("android","macos"))
        for(key in listOf("region","repeat","repeatParent")) rule.optJSONObject(key)?.let(::selector)
        if(rule.has("repeatParent") || rule.has("repeatSubtreeHash"))require(rule.has("repeat"))
        if(rule.has("repeatSubtreeHash"))require(Regex("[a-f0-9]{64}").matches(rule.getString("repeatSubtreeHash")))
        val required=rule.optJSONArray("required")?:JSONArray();require(required.length()<=8);for(i in 0 until required.length())selector(required.getJSONObject(i))
        require(rule.has("fields"));val fields=rule.getJSONObject("fields");require(fields.length() in 1..32)
        for(name in fields.keys()) {
            require(fieldName.matches(name));val f=fields.getJSONObject(name)
            require(f.has("select")&&f.keys().asSequence().all { it in setOf("select","ancestor","childPath","required","source","cardinality") });selector(f.getJSONObject("select"));f.optJSONObject("ancestor")?.let(::selector)
            require(f.optString("source","text") in setOf("text","description","state") && f.optString("cardinality","one") in setOf("one","many"))
            if(f.has("required"))require(f.get("required") is Boolean)
            f.optJSONArray("childPath")?.let { path ->require(rule.has("region")||rule.has("repeat"));require(path.length() in 0..24);for(i in 0 until path.length())require(path.getDouble(i)==path.getInt(i).toDouble()&&path.getInt(i) in 0..4095) }
        }
    }
    private fun selector(s:JSONObject){require(s.length() in 1..3 && s.keys().asSequence().all { it in setOf("resourceId","role","textEquals") });for(k in s.keys())require(s.get(k) is String && s.getString(k).length in (if(k=="textEquals")0..500 else 1..300))}
    private fun matches(n:JSONObject,s:JSONObject)=s.keys().asSequence().all { n.optString(if(it=="textEquals")"text" else it)==s.getString(it) }
    fun page(snapshot:JSONObject,rule:JSONObject,fields:JSONArray,at:String,truncated:Boolean=snapshot.optBoolean("truncated")):JSONObject = JSONObject()
        .put("version",3).put("scope","visible_window").put("adapterId",rule.getString("id")).put("adapterVersion",rule.getString("version"))
        .put("activity",snapshot.optString("activity")).put("appVersion",snapshot.optString("appVersion")).put("status",if(truncated)"partial" else "ok").put("truncated",truncated)
        .put("observations",JSONObject().put("firstAt",at).put("lastAt",at).put("count",1)).put("objects",JSONArray().put(JSONObject().put("kind",rule.getString("kind")).put("fields",sorted(fields))))
    private fun sorted(fields:JSONArray)=JSONArray((0 until fields.length()).map(fields::getJSONObject).sortedBy{it.getString("name")})
    fun extract(snapshot:JSONObject,rule:JSONObject,at:String):List<JSONObject> {
        val array=snapshot.getJSONArray("nodes");val nodes=(0 until array.length()).map(array::getJSONObject);val byId=nodes.associateBy { it.getString("id") }
        fun children(id:String)=nodes.filter { it.optString("parentId")==id }.sortedBy { it.optInt("childIndex",nodes.indexOf(it)) }
        fun under(n:JSONObject,id:String?):Boolean {if(id==null)return true;var current:JSONObject?=n;repeat(1024){if(current?.optString("id")==id)return true;current=byId[current?.optString("parentId")]};return false}
        val hashes=mutableMapOf<String,String>()
        fun hash(n:JSONObject,depth:Int=0):String {
            if(depth>32)return "";val id=n.getString("id");hashes[id]?.let{return it}
            return UiStructureHash.hash(n.optString("resourceId"),n.optString("role"),children(id).map {hash(it,depth+1)}).also{hashes[id]=it}
        }
        val regions=rule.optJSONObject("region")?.let{s->nodes.filter{matches(it,s)}}
        if(regions!=null&&regions.size!=1)return emptyList();val region=regions?.singleOrNull()?.getString("id")
        val roots:List<JSONObject?> = rule.optJSONObject("repeat")?.let{s->nodes.filter {n->under(n,region)&&matches(n,s)&&(!rule.has("repeatParent")||byId[n.optString("parentId")]?.let{matches(it,rule.getJSONObject("repeatParent"))}==true)&&(!rule.has("repeatSubtreeHash")||hash(n)==rule.getString("repeatSubtreeHash"))}}?:listOf(regions?.singleOrNull())
        val results=mutableListOf<JSONObject>()
        for(root in roots.take(16)) {
            val fields=JSONArray();var failed=false;var clipped=roots.size>16;var count=0;var budget=64000
            val definitions=rule.getJSONObject("fields")
            for(name in definitions.keys().asSequence().toList().sorted()) {
                val f=definitions.getJSONObject(name);var target=root
                val path=f.optJSONArray("childPath");if(path!=null)for(i in 0 until path.length()){target=target?.let{p->children(p.getString("id")).singleOrNull{it.optInt("childIndex",-1)==path.getInt(i)}}}
                val source=f.optString("source","text")
                val values=nodes.filter {n-> under(n,root?.getString("id"))&&under(n,region)&&(path==null||target?.getString("id")==n.getString("id"))&&matches(n,f.getJSONObject("select"))&&
                    (!f.has("ancestor")||run {var parent=byId[n.optString("parentId")];var found=false;for(d in 0 until 32){val p=parent?:break;if(matches(p,f.getJSONObject("ancestor"))){found=true;break};if(p.optString("id")==root?.optString("id"))break;parent=byId[p.optString("parentId")]};found})}
                    .map{it.optString(if(source=="description")"description" else if(source=="state")"state" else "text")}.filter{it.isNotBlank()}
                if(f.optString("cardinality","one")=="one"&&values.size!=1){if(f.optBoolean("required"))failed=true;continue}
                val accepted=JSONArray()
                for(value in values) {
                    if(accepted.length()>=64||count>=128||budget<=0){clipped=true;break}
                    var end=minOf(value.length,32000,budget)
                    if(end in 1 until value.length&&value[end-1].isHighSurrogate()&&value[end].isLowSurrogate())end--
                    val text=value.substring(0,end)
                    if(text.length<value.length)clipped=true
                    if(text.isBlank()){clipped=true;break}
                    accepted.put(JSONObject().put("text",text).put("source",source));count++;budget-=text.length
                }
                if(accepted.length()==0){if(f.optBoolean("required"))failed=true}else fields.put(JSONObject().put("name",name).put("values",accepted))
            }
            if(!failed&&fields.length()>0)results+=page(snapshot,rule,fields,at,snapshot.optBoolean("truncated")||clipped)
        }
        return results
    }
    fun text(page:JSONObject)=page.getJSONArray("objects").getJSONObject(0).getJSONArray("fields").let{fields->(0 until fields.length()).flatMap{i->val values=fields.getJSONObject(i).getJSONArray("values");(0 until values.length()).map{values.getJSONObject(it).getString("text")}}.joinToString("\n")}
    fun validatePage(p:JSONObject){
        require(p.getInt("version")==3&&p.getJSONArray("objects").length()==1)
        val o=p.getJSONArray("objects").getJSONObject(0);require(o.keys().asSequence().toSet()==setOf("kind","fields")&&o.getString("kind").length in 1..100)
        val fields=o.getJSONArray("fields");require(fields.length() in 1..32);val names=mutableSetOf<String>();var count=0;var length=0
        for(i in 0 until fields.length()){val f=fields.getJSONObject(i);require(f.keys().asSequence().toSet()==setOf("name","values")&&fieldName.matches(f.getString("name"))&&names.add(f.getString("name")));val values=f.getJSONArray("values");require(values.length() in 1..64);for(j in 0 until values.length()){val v=values.getJSONObject(j);require(v.keys().asSequence().toSet()==setOf("text","source")&&v.getString("text").isNotBlank()&&v.getString("text").length<=32000&&v.getString("source") in setOf("text","description","ocr","state"));count++;length+=v.getString("text").length}}
        require(count<=128&&length<=64000)
    }
}
