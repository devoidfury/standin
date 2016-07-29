;((global)=>{
	const PRINT_UNDEFINED = false

	// cross-browser el.matches prototype.
	// https://developer.mozilla.org/en-US/docs/Web/API/Element/matches
	if (!Element.prototype.matches) {
		const proto = Element.prototype
		proto.matches = proto.matchesSelector ||
			proto.mozMatchesSelector || proto.msMatchesSelector ||
			proto.webkitMatchesSelector || function(s) {
				const matches = (this.document || this.ownerDocument).querySelectorAll(s)
				let i = matches.length
				while (--i >= 0 && matches.item(i) !== this) {}
				return i > -1
			}
	}

	// traverse an object for a dot-notation path
	// for example, a fullkey like "home.options.2"
	// would return obj.home.options[2].
	// we need this for detecting bindings in html strings.
	function deepGetter(obj, fullkey) {
		const key = fullkey.split('.', 1)[0]
		const rest = fullkey.substr(key.length + 1)
		const current = Array.isArray(obj) ? obj[parseInt(key, 10)] : obj[key]
		return rest && rest.length ? deepGetter(current, rest) : current
	}

	// just like deepGetter, but return [parent of lastprop, lastprop]
	// for getting access to set trap
	function deepParentGetter(obj, fullkey) {
		const splitIdx = fullkey.lastIndexOf('.')
		if (splitIdx === -1) return [obj, fullkey]
		const key = fullkey.substr(0, splitIdx)
		return [deepGetter(obj, key), fullkey.substr(splitIdx+1)]
	}

	// wrap an object/array and recursively all it's descendants in Proxy,
	// allowing detection of set operations on any nested properties
	// setcb - function to call when a property is updated.
	//			returns true if changes need to be tracked
	// changes - array of diff operations to build
	// parent - string path to current property from root ctx
	// val - current value to wrap
	// if val is a primitive type, returns val
	// this should be improved, just a rough draft
	function deepCTX(setcb, changes, parent, val) {
		if (Array.isArray(val))
			for (let i = 0; i < val.length; i++) {
				const deepkey = parent ? `${parent}.${i}` : ''+i
				val[i] = deepCTX(setcb, changes, deepkey, val[i])
			}
		else if (val && typeof val === 'object')
			Object.keys(val).forEach(function(k) {
				const deepkey = parent ? `${parent}.${k}` : k
				val[k] = deepCTX(setcb, changes, deepkey, val[k])
			})
		else return val
		// transparent proxy with set trap on objects/arrays
		return new Proxy(val, {
			set: (target, key, value, receiver) => {
				const deepkey = parent ? `${parent}.${key}` : key
				// todo: handle arrays better
				if (setcb()) changes.push(deepkey)
				target[key] = deepCTX(setcb, changes, deepkey, value)
				return true // indicate assignment succeeded
			},
			deleteProperty: (target, key) => {
				// todo; array manipulations and delete
			}
		})
	}

	// primary context container. keeps track of data bindings,
	// the proxied data, changelist, and rendering
	function CTX(root) {
		this.root = root
		this.is_rendering = false
		this.auto_schedule = true
		this.detecting = true
		this.changes = []
		this.bindings = {}
		this.data = deepCTX(
			() => this.schedule_render(false) || this.detecting,
			this.changes,
			'', // this is the root ctx frame
			Object.create(null)
		)
	}

	// sugar for deepGetters using ctx.data
	CTX.prototype.find = function(deepkey) {
		return deepGetter(this.data, deepkey)
	}
	CTX.prototype.findParent = function(deepkey) {
		return deepParentGetter(this.data, deepkey)
	}

	// instead of performing renders everytime we see a change,
	// schedule one to happen on the next tick. idempotent per tick.
	// (rendering is expensive, do it all at once and save cycles)
	// pass true to force a scheduled render if not in auto_schedule mode
	CTX.prototype.schedule_render = function(explicit) {
		if (!this.is_rendering && (this.auto_schedule || explicit)) {
			this.is_rendering = true
			this._rtimer = setTimeout(this.render.bind(this), 0)
		}
		return this
	}

	// cancel upcoming scheduled render
	// note that if auto_schedule is on and any ctx.data is changed later,
	// another render will be scheduled.
	CTX.prototype.cancel_render = function() {
		if (this.is_rendering) {
			this.is_rendering = false
			clearTimeout(this._rtimer)
		}
		return this
	}

	// change notification tree trimmer
	// if a parent node is modified and any descendant changes
	// are in the list, skip past them
	function peekAheadSkip(key, i, changes) {
		while (true) {
			const change = changes[i+1]
			if (change &&
				change.indexOf(key) === 0 &&
				changes[i+1][key.length] === '.')
			i++; else break
		}
		return i
	}
	// this is expensive, you should probably be using
	// auto_schedule mode or calling schedule_render(true)
	CTX.prototype.render = function() {
		const changes = [...new Set(this.changes)].sort()
		for (let i = 0; i < changes.length; i++) {
			const key = changes[i]
			i = peekAheadSkip(key, i, changes)

			// automatically include descendant changes
			const currentchanges = [key, ...Object.keys(this.bindings).filter(
				b => b.indexOf(key) === 0 && b[key.length] === '.'
			)]

			for (let changekey of currentchanges) {
				const binds = this.bindings[changekey] || []
				// rendering happens here
				for (let binding of binds)
					BIND_TYPES[binding.type].handle(binding.el, this, changekey)
			}
		}
		this.changes.splice(0, this.changes.length) // empty changelist
		this.cancel_render() // clear pending renders on same ctx
	}

	// hooks up a binding. called in auto for each binding defined
	CTX.prototype.add_binding = function(el, deepkey, type, selector) {
		const binds = this.bindings
		if (!binds[deepkey])
			binds[deepkey] = []
		if (BIND_TYPES[type].init && // only call init if it's unique to key && type
				!binds[deepkey].some(b => b.type === type))
			BIND_TYPES[type].init(selector, this, deepkey)
		binds[deepkey].push({el, type})
		return this
	}

	// hook up bindings defined in DOM by grabbing them all
	CTX.prototype.auto = function() {
		Object.keys(BIND_TYPES).forEach(type => {
			const datatype_attr = `data-${type}`
			const selector = `[${datatype_attr}]`
			const els = this.root.querySelectorAll(selector)
			for (let el of els)
				this.add_binding(el,
					el.getAttribute(datatype_attr),
					type,
					selector)
		})
		return this
	}

	// delegated event handlers
	function on(el, name, selector, fn) {
		el.addEventListener(name, function(e) {
			if (e.target.matches(selector)) return Reflect.apply(fn, e.target, [e])
		})
	}
	CTX.prototype.on = function(name, selector, fn) {
		on(this.root, name, selector, fn)
		return this
	}

	const emptyIfUndefined = PRINT_UNDEFINED ?
		v => v :
		v => v === undefined ? '' : v

	// operations to perform with different data-* bindings
	const BIND_TYPES = {
		html: {
			handle(el, ctx, key) {
				el.innerHTML = emptyIfUndefined(ctx.find(key))
			}
		},
		text: {
			handle(el, ctx, key) {
				el.textContent = emptyIfUndefined(ctx.find(key))
			}
		},
		'bind-text': {
			handle(el, ctx, key) {
				el.value = emptyIfUndefined(ctx.find(key))
			},
			init(selector, ctx, key) {
				ctx.on('keyup', selector, function(e) {
					const access = ctx.findParent(key)
					if (access[0][access[1]] !== e.target.value)
						access[0][access[1]] = e.target.value
				})}
		},
		'bind-checkbox': {
			handle(el, ctx, key) { el.checked = !!ctx.find(key) },
			init(selector, ctx, key) {
				ctx.on('change', selector, function(e) {
					const access = ctx.findParent(key)
					access[0][access[1]] = !!e.target.checked
				})}
		}
	}

	global.standin = {CTX, BIND_TYPES, deepGetter, deepParentGetter, on}
})(window);
