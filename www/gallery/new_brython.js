function run($B){

__BRYTHON__.debug = 1



function ajax_search(module, path_num){
    var req = new XMLHttpRequest()
    req.open("GET", __BRYTHON__.path[path_num] + "/" + module + ".py", true)
    req.onreadystatechange = function (){
        if(this.readyState==4){
            if(this.status==200){
                __BRYTHON__.module_source[module] = this.responseText.length
                if(this.path != "libs"){
                    var root = __BRYTHON__.py2js(this.responseText, module,
                        module, "__builtins__")
                    __BRYTHON__.module_source[module] = root.to_js()
                    for(var key in root.imports){
                        if(!__BRYTHON__.module_source.hasOwnProperty(key)){
                            tasks.splice(0, 0, [inImported, key])
                        }
                    }
                }
            }else if(this.status==404){
                if(path_num < $B.path.length-1){
                    tasks.splice(0, 0,
                        [ajax_search, module, path_num + 1])
                }
            }
            loop()
        }
    }
    req.send()
}

function ajax_load_script(url, script_id){
    var req = new XMLHttpRequest()
    req.open("GET", url, true)
    req.onreadystatechange = function(){
        if(this.readyState==4){
            if(this.status==200){
                var src = this.responseText,
                    root = $B.py2js(src, script_id, script_id, "__builtins__"),
                    js = root.to_js()
                for(var key in root.imports){
                    if(!__BRYTHON__.module_source.hasOwnProperty(key)){
                        tasks.splice(0, 0, [inImported, key])
                    }
                }
                tasks.splice(0, 0, ["execute", js])
            }else if(this.status==404){
                throw Error(this.url+" not found")
            }
            loop()
        }
    }
    req.send()
}

function inImported(module){
    if(__BRYTHON__.imported.hasOwnProperty(module)){
        __BRYTHON__.module_source[module] = "in imported"
    }else if(__BRYTHON__.stdlib.hasOwnProperty(module)){
        var elts = __BRYTHON__.VFS[module]
        if(elts === undefined){console.log('bizarre', module)}
        var ext = elts[0],
            source = elts[1],
            is_package = elts.length==3
        if(ext==".py"){
            tasks.splice(0, 0, [idb_get, module])
        }else{
            // Use built-in Javascript module
            source += "\nvar $locals_" +
                module.replace(/\./g, "_") + " = $module"
            __BRYTHON__.module_source[module] = source
        }
    }else{
        tasks.splice(0, 0, [ajax_search, module, 0])
    }
    loop()
}

var idb_cx

function idb_load(evt, module){
    // Callback function of a request to the indexedDB database with a module
    // name as key.
    // If the module is precompiled and its timestamp is the same as in
    // brython_stdlib, use the precompiled Javascript.
    // Otherwise, get the source code from brython_stdlib.js. If
    var res = evt.target.result

    if(res===undefined || res.timestamp != __BRYTHON__.timestamp){
        // Not found or not with the same date as in brython_stdlib.js:
        // search in VFS
        if(__BRYTHON__.VFS[module] !== undefined){
            var elts = __BRYTHON__.VFS[module],
                ext = elts[0],
                source = elts[1],
                is_package = elts.length==3
            if(ext==".py"){
                // Precompile Python module
                var root = __BRYTHON__.py2js(source, module, module,
                        "__builtins__"),
                    js = root.to_js(),
                    imports = root.imports
                imports = Object.keys(imports).join(",")
                tasks.splice(0, 0, [store_precompiled,
                    module, js, imports, is_package])
            }else{
                console.log('bizarre', module, ext)
            }
        }else{
            // Module not found : do nothing
        }
    }else{
        // Precompiled Javascript found in indexedDB database.
        __BRYTHON__.module_source[module] = res.content
        if(res.imports.length>0){
            // res.impots is a string with the modules imported by the current
            // modules, separated by commas
            var subimports = res.imports.split(",")
            for(var i=0;i<subimports.length;i++){
                var subimport = subimports[i]
                if(subimport.startsWith(".")){
                    // Relative imports
                    var url_elts = module.split("."),
                        nb_dots = 0
                    while(subimport.startsWith(".")){
                        nb_dots++
                        subimport = subimport.substr(1)
                    }
                    var elts = url_elts.slice(0, nb_dots)
                    if(subimport){
                        elts = elts.concat([subimport])
                    }
                    subimport = elts.join(".")
                }
                if(!__BRYTHON__.imported.hasOwnProperty(subimport) &&
                        !__BRYTHON__.module_source.hasOwnProperty(subimport)){
                    // If the code of the required module is not already
                    // loaded, add a task for this.
                    //console.log('subimport', subimport)
                    tasks.splice(0, 0, [inImported, subimport])
                }
            }
        }
    }
    loop()
}

function store_precompiled(module, js, imports, is_package){
    // Sends a request to store the compiled Javascript for a module.
    var db = idb_cx.result,
        tx = db.transaction("modules", "readwrite"),
        store = tx.objectStore("modules"),
        cursor = store.openCursor(),
        data = {"name": module, "content": js,
            "imports": imports,
            "timestamp": __BRYTHON__.timestamp,
            "is_package": is_package},
        request = store.put(data)
    request.onsuccess = function(evt){
        // Restart the task "idb_get", knowing that this time it will use
        // the compiled version.
        tasks.splice(0, 0, [idb_get, module])
        loop()
    }
}

function idb_get(module){
    // Sends a request to the indexedDB database for the module name.
    var db = idb_cx.result,
        tx = db.transaction("modules", "readonly")

    try{
        var store = tx.objectStore("modules")
            req = store.get(module)
        req.onsuccess = function(evt){idb_load(evt, module)}
    }catch(err){
        console.log('error', err)
    }
}

function create_db(evt){
    // The database did not previously exist, create object store.
    var db = idb_cx.result,
        store = db.createObjectStore("modules", {"keyPath": "name"})
    store.onsuccess = loop
    store.onerror = function(){
        console.log('erreur')
    }
}

function idb_open(obj){
    idb_cx = indexedDB.open("brython_stdlib")
    idb_cx.onsuccess = function(){
        var db = idb_cx.result
        if(!db.objectStoreNames.contains("modules")){
            var version = db.version
            db.close()
            console.log('create object store', version)
            idb_cx = indexedDB.open("brython_stdlib", version+1)
            idb_cx.onupgradeneeded = function(){
                console.log("upgrade needed")
                var db = idb_cx.result,
                    store = db.createObjectStore("modules", {"keyPath": "name"})
                store.onsuccess = loop
            }
            idb_cx.onversionchanged = function(){
                console.log("version changed")
            }
            idb_cx.onsuccess = function(){
                console.log("db opened", idb_cx)
                var db = idb_cx.result,
                    store = db.createObjectStore("modules", {"keyPath": "name"})
                store.onsuccess = loop
            }
        }else{
            console.log("object store exists")
            loop()
        }
    }
    idb_cx.onupgradeneeded = function(){
        console.log("upgrade needed")
        var db = idb_cx.result,
            store = db.createObjectStore("modules", {"keyPath": "name"})
        store.onsuccess = loop
    }
    idb_cx.onerror = function(){
        console.log('erreur open')
    }
}

var tasks = [],
    scripts = document.querySelectorAll('[type="text/pythonXXX"]'),
    script_num

// Build the list of tasks to run.
// A task is a list of items:
// - item[0] is a function, or the string "execute"
// - if it is a function, it is executed with the next items as arguments.
//   The function may add a new task at the beginning of the tasks list.
// - if it is the string "execute", item[1] is the Javascript code to execute

// Start with the task that opens the database, or create it if it doesn't
// exist.
tasks.push([idb_open])

// Add a task for each script in the page
for(var i=0; i<scripts.length; i++){
    var script_id = scripts[i].getAttribute("id")
    if(!script_id){
        if(script_num===undefined){
            script_id = "__main__"
            script_num = 0
        }else{
            script_id = "__main__" + script_num
            script_num++
        }
    }
    if(scripts[i].getAttribute("src")){
        // Add task to load the external script
        tasks.push([ajax_load_script,
            scripts[i].getAttribute("src"), script_id])
    }else{
        var src = scripts[i].textContent,
            root = __BRYTHON__.py2js(src, script_id, script_id,
                "__builtins__"),
            js = root.to_js(),
            imports = Object.keys(root.imports)

        for(var j=0; j<imports.length;j++){
           tasks.push([inImported, imports[j]])
        }
        tasks.push(["execute", js])
    }
}

// Function loop() takes the first task in the tasks list and processes it.
// The function executed in loop() may itself add new tasks and call loop().
function loop(){
    if(tasks.length==0){
        // No more tasks to process.
        idb_cx.result.close()
        return
    }
    var task = tasks.shift(),
        func = task[0],
        args = task.slice(1)

    if(func == "execute"){
        try{
            eval(task[1])
        }catch(err){
            if($B.debug>1){
                console.log(err)
                for(var attr in err){
                   console.log(attr+' : ', err[attr])
                }
            }

            // If the error was not caught by the Python runtime, build an
            // instance of a Python exception
            if(err.$py_error===undefined){
                console.log('Javascript error', err)
                //console.log(js)
                //for(var attr in $err){console.log(attr+': '+$err[attr])}
                err=_b_.RuntimeError(err+'')
            }

            // Print the error traceback on the standard error stream
            var name = err.__name__,
                trace = _b_.getattr(err,'info')
            if(name=='SyntaxError' || name=='IndentationError'){
                var offset = err.args[3]
                trace += '\n    ' + ' '.repeat(offset) + '^' +
                    '\n' + name+': '+err.args[0]

            }else{
                trace += '\n'+name+': ' + err.args
            }
            try{
                _b_.getattr($B.stderr,'write')(trace)
            }catch(print_exc_err){
                console.log(trace)
            }
            // Throw the error to stop execution
            throw err

        }
        loop()
    }else{
        // Run function with arguments
        func.apply(null, args)
    }
}

loop()
}

run(__BRYTHON__)
