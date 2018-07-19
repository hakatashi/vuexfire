'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.firebaseMutations = undefined;
exports.firebaseAction = firebaseAction;

var _utils = require('./utils');

var _mutations = require('./mutations');

var _mutations2 = _interopRequireDefault(_mutations);

var _types = require('./types');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const firebaseMutations = exports.firebaseMutations = {};
const commitOptions = { root: true };

Object.keys(_mutations2.default).forEach(type => {
  // the { commit, state, type, ...payload } syntax is not supported by buble...
  firebaseMutations[type] = (_, context) => {
    _mutations2.default[type](context.state, context);
  };
});

function unsubscribeAll(subs) {
  for (const sub in subs) {
    subs[sub].unsub();
  }
}

// NOTE not convinced by the naming of subscribeToRefs and subscribeToDocument
// first one is calling the other on every ref and subscribeToDocument may call
// updateDataFromDocumentSnapshot which may call subscribeToRefs as well
function subscribeToRefs({
  subs,
  refs,
  target,
  path,
  data,
  depth,
  commit,
  resolve
}, options) {
  const refKeys = Object.keys(refs);
  const missingKeys = Object.keys(subs).filter(refKey => refKeys.indexOf(refKey) < 0);
  // unbind keys that are no longer there
  missingKeys.forEach(refKey => {
    subs[refKey].unsub();
    delete subs[refKey];
  });
  if (!refKeys.length || ++depth > options.maxRefDepth) return resolve(path);

  let resolvedCount = 0;
  const totalToResolve = refKeys.length;
  const validResolves = Object.create(null);
  function deepResolve(key) {
    if (key in validResolves) {
      if (++resolvedCount >= totalToResolve) resolve(path);
    }
  }

  refKeys.forEach(refKey => {
    const sub = subs[refKey];
    const ref = refs[refKey];
    const docPath = `${path}.${refKey}`;

    validResolves[docPath] = true;

    // unsubscribe if bound to a different ref
    if (sub) {
      if (sub.path !== ref.path) sub.unsub();
      // if has already be bound and as we always walk the objects, it will work
      else return;
    }

    subs[refKey] = {
      unsub: subscribeToDocument({
        ref,
        target,
        path: docPath,
        depth,
        commit,
        resolve: deepResolve.bind(null, docPath)
      }, options),
      path: ref.path
    };
  });
}

function bindCollection({
  vm,
  key,
  collection,
  commit,
  resolve,
  reject
}, options) {
  commit(_types.VUEXFIRE_SET_VALUE, {
    path: key,
    target: vm,
    data: []
  }, commitOptions);
  const target = (0, _utils.walkGet)(vm, key);
  const originalResolve = resolve;
  let isResolved;

  // contain ref subscriptions of objects
  // arraySubs is a mirror of array
  const arraySubs = [];

  const change = {
    added: ({ newIndex, doc }) => {
      arraySubs.splice(newIndex, 0, Object.create(null));
      const subs = arraySubs[newIndex];
      const snapshot = (0, _utils.createSnapshot)(doc);
      const [data, refs] = (0, _utils.extractRefs)(snapshot);
      commit(_types.VUEXFIRE_ARRAY_ADD, { target, newIndex, data }, commitOptions);
      subscribeToRefs({
        data,
        refs,
        subs,
        target,
        path: newIndex,
        depth: 0,
        commit,
        resolve: resolve.bind(null, doc)
      }, options);
    },
    modified: ({ oldIndex, newIndex, doc }) => {
      const subs = arraySubs.splice(oldIndex, 1)[0];
      arraySubs.splice(newIndex, 0, subs);
      // const oldData = array.splice(oldIndex, 1)[0]
      const oldData = commit(_types.VUEXFIRE_ARRAY_REMOVE, { target, oldIndex }, commitOptions);
      const snapshot = (0, _utils.createSnapshot)(doc);
      const [data, refs] = (0, _utils.extractRefs)(snapshot, oldData);
      // array.splice(newIndex, 0, data)
      commit(_types.VUEXFIRE_ARRAY_ADD, { target, newIndex, data }, commitOptions);
      subscribeToRefs({
        data,
        refs,
        subs,
        target,
        path: newIndex,
        depth: 0,
        commit,
        resolve
      }, options);
    },
    removed: ({ oldIndex }) => {
      // array.splice(oldIndex, 1)
      commit(_types.VUEXFIRE_ARRAY_REMOVE, { target, oldIndex }, commitOptions);
      unsubscribeAll(arraySubs.splice(oldIndex, 1)[0]);
    }
  };

  const unbind = collection.onSnapshot(ref => {
    // console.log('pending', metadata.hasPendingWrites)
    // docs.forEach(d => console.log('doc', d, '\n', 'data', d.data()))
    // NOTE this will only be triggered once and it will be with all the documents
    // from the query appearing as added
    // (https://firebase.google.com/docs/firestore/query-data/listen#view_changes_between_snapshots)
    const docChanges = typeof ref.docChanges === 'function' ? ref.docChanges() : ref.docChanges;

    if (!isResolved && docChanges.length) {
      // isResolved is only meant to make sure we do the check only once
      isResolved = true;
      let count = 0;
      const expectedItems = docChanges.length;
      const validDocs = docChanges.reduce((dict, { doc }) => {
        dict[doc.id] = false;
        return dict;
      }, Object.create(null));
      resolve = ({ id }) => {
        if (id in validDocs) {
          if (++count >= expectedItems) {
            originalResolve(vm[key]);
            // reset resolve to noop
            resolve = _ => {};
          }
        }
      };
    }
    docChanges.forEach(c => {
      change[c.type](c);
    });

    // resolves when array is empty
    if (!docChanges.length) resolve();
  }, reject);

  return () => {
    unbind();
    arraySubs.forEach(unsubscribeAll);
  };
}

function updateDataFromDocumentSnapshot({
  snapshot,
  target,
  path,
  subs,
  depth = 0,
  commit,
  resolve
}, options) {
  const [data, refs] = (0, _utils.extractRefs)(snapshot, (0, _utils.walkGet)(target, path));
  commit(_types.VUEXFIRE_SET_VALUE, {
    path,
    target,
    data
  }, commitOptions);
  subscribeToRefs({
    data,
    subs,
    refs,
    target,
    path,
    depth,
    commit,
    resolve
  }, options);
}

function subscribeToDocument({
  ref,
  target,
  path,
  depth,
  commit,
  resolve
}, options) {
  const subs = Object.create(null);
  const unbind = ref.onSnapshot(doc => {
    if (doc.exists) {
      updateDataFromDocumentSnapshot({
        snapshot: (0, _utils.createSnapshot)(doc),
        target,
        path,
        subs,
        depth,
        commit,
        resolve
      }, options);
    } else {
      commit(_types.VUEXFIRE_SET_VALUE, {
        target,
        path,
        data: null
      }, commitOptions);
      resolve(path);
    }
  });

  return () => {
    unbind();
    unsubscribeAll(subs);
  };
}

function bindDocument({
  vm,
  key,
  document,
  commit,
  resolve,
  reject
}, options) {
  // TODO warning check if key exists?
  // const boundRefs = Object.create(null)

  const subs = Object.create(null);
  // bind here the function so it can be resolved anywhere
  // this is specially useful for refs
  // TODO use walkGet?
  resolve = (0, _utils.callOnceWithArg)(resolve, () => vm[key]);
  const unbind = document.onSnapshot(doc => {
    if (doc.exists) {
      updateDataFromDocumentSnapshot({
        snapshot: (0, _utils.createSnapshot)(doc),
        target: vm,
        path: key,
        subs,
        commit,
        resolve
      }, options);
    } else {
      resolve();
    }
  }, reject);

  return () => {
    unbind();
    unsubscribeAll(subs);
  };
}

// Firebase binding
const subscriptions = new WeakMap();

function bind({
  state,
  commit,
  key,
  ref
}, options = { maxRefDepth: 2 }) {
  // TODO check ref is valid
  // TODO check defined in state
  let sub = subscriptions.get(commit);
  if (!sub) {
    sub = Object.create(null);
    subscriptions.set(commit, sub);
  }

  // unbind if ref is already bound
  if (key in sub) {
    unbind({ commit, key });
  }

  return new Promise((resolve, reject) => {
    sub[key] = ref.where ? bindCollection({
      vm: state,
      key,
      collection: ref,
      commit,
      resolve,
      reject
    }, options) : bindDocument({
      vm: state,
      key,
      document: ref,
      commit,
      resolve,
      reject
    }, options);
  });
}

function unbind({
  commit,
  key
}) {
  let sub = subscriptions.get(commit);
  if (!sub) return;
  // TODO dev check before
  sub[key]();
  delete sub[key];
}

function firebaseAction(action) {
  return function firebaseEnhancedActionFn(context, payload) {
    // get the local state and commit. These may be bound to a module
    const { state, commit } = context;
    context.bindFirebaseRef = (key, ref, options = {}) => bind({ state, commit, key, ref }, options);
    context.unbindFirebaseRef = key => unbind({ commit, key });
    return action(context, payload);
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uL3NyYy9pbmRleC5qcyJdLCJuYW1lcyI6WyJmaXJlYmFzZUFjdGlvbiIsImZpcmViYXNlTXV0YXRpb25zIiwiY29tbWl0T3B0aW9ucyIsInJvb3QiLCJPYmplY3QiLCJrZXlzIiwibXV0YXRpb25zIiwiZm9yRWFjaCIsInR5cGUiLCJfIiwiY29udGV4dCIsInN0YXRlIiwidW5zdWJzY3JpYmVBbGwiLCJzdWJzIiwic3ViIiwidW5zdWIiLCJzdWJzY3JpYmVUb1JlZnMiLCJyZWZzIiwidGFyZ2V0IiwicGF0aCIsImRhdGEiLCJkZXB0aCIsImNvbW1pdCIsInJlc29sdmUiLCJvcHRpb25zIiwicmVmS2V5cyIsIm1pc3NpbmdLZXlzIiwiZmlsdGVyIiwicmVmS2V5IiwiaW5kZXhPZiIsImxlbmd0aCIsIm1heFJlZkRlcHRoIiwicmVzb2x2ZWRDb3VudCIsInRvdGFsVG9SZXNvbHZlIiwidmFsaWRSZXNvbHZlcyIsImNyZWF0ZSIsImRlZXBSZXNvbHZlIiwia2V5IiwicmVmIiwiZG9jUGF0aCIsInN1YnNjcmliZVRvRG9jdW1lbnQiLCJiaW5kIiwiYmluZENvbGxlY3Rpb24iLCJ2bSIsImNvbGxlY3Rpb24iLCJyZWplY3QiLCJWVUVYRklSRV9TRVRfVkFMVUUiLCJvcmlnaW5hbFJlc29sdmUiLCJpc1Jlc29sdmVkIiwiYXJyYXlTdWJzIiwiY2hhbmdlIiwiYWRkZWQiLCJuZXdJbmRleCIsImRvYyIsInNwbGljZSIsInNuYXBzaG90IiwiVlVFWEZJUkVfQVJSQVlfQUREIiwibW9kaWZpZWQiLCJvbGRJbmRleCIsIm9sZERhdGEiLCJWVUVYRklSRV9BUlJBWV9SRU1PVkUiLCJyZW1vdmVkIiwidW5iaW5kIiwib25TbmFwc2hvdCIsImRvY0NoYW5nZXMiLCJjb3VudCIsImV4cGVjdGVkSXRlbXMiLCJ2YWxpZERvY3MiLCJyZWR1Y2UiLCJkaWN0IiwiaWQiLCJjIiwidXBkYXRlRGF0YUZyb21Eb2N1bWVudFNuYXBzaG90IiwiZXhpc3RzIiwiYmluZERvY3VtZW50IiwiZG9jdW1lbnQiLCJzdWJzY3JpcHRpb25zIiwiV2Vha01hcCIsImdldCIsInNldCIsIlByb21pc2UiLCJ3aGVyZSIsImFjdGlvbiIsImZpcmViYXNlRW5oYW5jZWRBY3Rpb25GbiIsInBheWxvYWQiLCJiaW5kRmlyZWJhc2VSZWYiLCJ1bmJpbmRGaXJlYmFzZVJlZiJdLCJtYXBwaW5ncyI6Ijs7Ozs7O1FBd1ZnQkEsYyxHQUFBQSxjOztBQXhWaEI7O0FBQ0E7Ozs7QUFDQTs7OztBQU1PLE1BQU1DLGdEQUFvQixFQUExQjtBQUNQLE1BQU1DLGdCQUFnQixFQUFFQyxNQUFNLElBQVIsRUFBdEI7O0FBRUFDLE9BQU9DLElBQVAsQ0FBWUMsbUJBQVosRUFBdUJDLE9BQXZCLENBQStCQyxRQUFRO0FBQ3JDO0FBQ0FQLG9CQUFrQk8sSUFBbEIsSUFBMEIsQ0FBQ0MsQ0FBRCxFQUFJQyxPQUFKLEtBQWdCO0FBQ3hDSix3QkFBVUUsSUFBVixFQUFnQkUsUUFBUUMsS0FBeEIsRUFBK0JELE9BQS9CO0FBQ0QsR0FGRDtBQUdELENBTEQ7O0FBT0EsU0FBU0UsY0FBVCxDQUF5QkMsSUFBekIsRUFBK0I7QUFDN0IsT0FBSyxNQUFNQyxHQUFYLElBQWtCRCxJQUFsQixFQUF3QjtBQUN0QkEsU0FBS0MsR0FBTCxFQUFVQyxLQUFWO0FBQ0Q7QUFDRjs7QUFFRDtBQUNBO0FBQ0E7QUFDQSxTQUFTQyxlQUFULENBQTBCO0FBQ3hCSCxNQUR3QjtBQUV4QkksTUFGd0I7QUFHeEJDLFFBSHdCO0FBSXhCQyxNQUp3QjtBQUt4QkMsTUFMd0I7QUFNeEJDLE9BTndCO0FBT3hCQyxRQVB3QjtBQVF4QkM7QUFSd0IsQ0FBMUIsRUFTR0MsT0FUSCxFQVNZO0FBQ1YsUUFBTUMsVUFBVXJCLE9BQU9DLElBQVAsQ0FBWVksSUFBWixDQUFoQjtBQUNBLFFBQU1TLGNBQWN0QixPQUFPQyxJQUFQLENBQVlRLElBQVosRUFBa0JjLE1BQWxCLENBQXlCQyxVQUFVSCxRQUFRSSxPQUFSLENBQWdCRCxNQUFoQixJQUEwQixDQUE3RCxDQUFwQjtB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LENBQUNoRCxHQUFELEVBQU1DLEdBQU4sRUFBV2QsVUFBVSxFQUFyQixLQUN4QmlCLEtBQUssRUFBRTlCLEtBQUYsRUFBU1csTUFBVCxFQUFpQmUsR0FBakIsRUFBc0JDLEdBQXRCLEVBQUwsRUFBa0NkLE9BQWxDLENBREY7QUFFQWQsWUFBUTRFLGlCQUFSLEdBQTZCakQsR0FBRCxJQUMxQnlCLE9BQU8sRUFBRXhDLE1BQUYsRUFBVWUsR0FBVixFQUFQLENBREY7QUFFQSxXQUFPNkMsT0FBT3hFLE9BQVAsRUFBZ0IwRSxPQUFoQixDQUFQO0FBQ0QsR0FSRDtBQVNEIiwiZmlsZSI6ImluZGV4LmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgY3JlYXRlU25hcHNob3QsIGV4dHJhY3RSZWZzLCBjYWxsT25jZVdpdGhBcmcsIHdhbGtHZXQgfSBmcm9tICcuL3V0aWxzJ1xyXG5pbXBvcnQgbXV0YXRpb25zIGZyb20gJy4vbXV0YXRpb25zJ1xyXG5pbXBvcnQge1xyXG4gIFZVRVhGSVJFX1NFVF9WQUxVRSxcclxuICBWVUVYRklSRV9BUlJBWV9BREQsXHJcbiAgVlVFWEZJUkVfQVJSQVlfUkVNT1ZFLFxyXG59IGZyb20gJy4vdHlwZXMnXHJcblxyXG5leHBvcnQgY29uc3QgZmlyZWJhc2VNdXRhdGlvbnMgPSB7fVxyXG5jb25zdCBjb21taXRPcHRpb25zID0geyByb290OiB0cnVlIH1cclxuXHJcbk9iamVjdC5rZXlzKG11dGF0aW9ucykuZm9yRWFjaCh0eXBlID0+IHtcclxuICAvLyB0aGUgeyBjb21taXQsIHN0YXRlLCB0eXBlLCAuLi5wYXlsb2FkIH0gc3ludGF4IGlzIG5vdCBzdXBwb3J0ZWQgYnkgYnVibGUuLi5cclxuICBmaXJlYmFzZU11dGF0aW9uc1t0eXBlXSA9IChfLCBjb250ZXh0KSA9PiB7XHJcbiAgICBtdXRhdGlvbnNbdHlwZV0oY29udGV4dC5zdGF0ZSwgY29udGV4dClcclxuICB9XHJcbn0pXHJcblxyXG5mdW5jdGlvbiB1bnN1YnNjcmliZUFsbCAoc3Vicykge1xyXG4gIGZvciAoY29uc3Qgc3ViIGluIHN1YnMpIHtcclxuICAgIHN1YnNbc3ViXS51bnN1YigpXHJcbiAgfVxyXG59XHJcblxyXG4vLyBOT1RFIG5vdCBjb252aW5jZWQgYnkgdGhlIG5hbWluZyBvZiBzdWJzY3JpYmVUb1JlZnMgYW5kIHN1YnNjcmliZVRvRG9jdW1lbnRcclxuLy8gZmlyc3Qgb25lIGlzIGNhbGxpbmcgdGhlIG90aGVyIG9uIGV2ZXJ5IHJlZiBhbmQgc3Vic2NyaWJlVG9Eb2N1bWVudCBtYXkgY2FsbFxyXG4vLyB1cGRhdGVEYXRhRnJvbURvY3VtZW50U25hcHNob3Qgd2hpY2ggbWF5IGNhbGwgc3Vic2NyaWJlVG9SZWZzIGFzIHdlbGxcclxuZnVuY3Rpb24gc3Vic2NyaWJlVG9SZWZzICh7XHJcbiAgc3VicyxcclxuICByZWZzLFxyXG4gIHRhcmdldCxcclxuICBwYXRoLFxyXG4gIGRhdGEsXHJcbiAgZGVwdGgsXHJcbiAgY29tbWl0LFxyXG4gIHJlc29sdmUsXHJcbn0sIG9wdGlvbnMpIHtcclxuICBjb25zdCByZWZLZXlzID0gT2JqZWN0LmtleXMocmVmcylcclxuICBjb25zdCBtaXNzaW5nS2V5cyA9IE9iamVjdC5rZXlzKHN1YnMpLmZpbHRlcihyZWZLZXkgPT4gcmVmS2V5cy5pbmRleE9mKHJlZktleSkgPCAwKVxyXG4gIC8vIHVuYmluZCBrZXlzIHRoYXQgYXJlIG5vIGxvbmdlciB0aGVyZVxyXG4gIG1pc3NpbmdLZXlzLmZvckVhY2gocmVmS2V5ID0+IHtcclxuICAgIHN1YnNbcmVmS2V5XS51bnN1YigpXHJcbiAgICBkZWxldGUgc3Vic1tyZWZLZXldXHJcbiAgfSlcclxuICBpZiAoIXJlZktleXMubGVuZ3RoIHx8ICsrZGVwdGggPiBvcHRpb25zLm1heFJlZkRlcHRoKSByZXR1cm4gcmVzb2x2ZShwYXRoKVxyXG5cclxuICBsZXQgcmVzb2x2ZWRDb3VudCA9IDBcclxuICBjb25zdCB0b3RhbFRvUmVzb2x2ZSA9IHJlZktleXMubGVuZ3RoXHJcbiAgY29uc3QgdmFsaWRSZXNvbHZlcyA9IE9iamVjdC5jcmVhdGUobnVsbClcclxuICBmdW5jdGlvbiBkZWVwUmVzb2x2ZSAoa2V5KSB7XHJcbiAgICBpZiAoa2V5IGluIHZhbGlkUmVzb2x2ZXMpIHtcclxuICAgICAgaWYgKCsrcmVzb2x2ZWRDb3VudCA+PSB0b3RhbFRvUmVzb2x2ZSkgcmVzb2x2ZShwYXRoKVxyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcmVmS2V5cy5mb3JFYWNoKHJlZktleSA9PiB7XHJcbiAgICBjb25zdCBzdWIgPSBzdWJzW3JlZktleV1cclxuICAgIGNvbnN0IHJlZiA9IHJlZnNbcmVmS2V5XVxyXG4gICAgY29uc3QgZG9jUGF0aCA9IGAke3BhdGh9LiR7cmVmS2V5fWBcclxuXHJcbiAgICB2YWxpZFJlc29sdmVzW2RvY1BhdGhdID0gdHJ1ZVxyXG5cclxuICAgIC8vIHVuc3Vic2NyaWJlIGlmIGJvdW5kIHRvIGEgZGlmZmVyZW50IHJlZlxyXG4gICAgaWYgKHN1Yikge1xyXG4gICAgICBpZiAoc3ViLnBhdGggIT09IHJlZi5wYXRoKSBzdWIudW5zdWIoKVxyXG4gICAgICAvLyBpZiBoYXMgYWxyZWFkeSBiZSBib3VuZCBhbmQgYXMgd2UgYWx3YXlzIHdhbGsgdGhlIG9iamVjdHMsIGl0IHdpbGwgd29ya1xyXG4gICAgICBlbHNlIHJldHVyblxyXG4gICAgfVxyXG5cclxuICAgIHN1YnNbcmVmS2V5XSA9IHtcclxuICAgICAgdW5zdWI6IHN1YnNjcmliZVRvRG9jdW1lbnQoe1xyXG4gICAgICAgIHJlZixcclxuICAgICAgICB0YXJnZXQsXHJcbiAgICAgICAgcGF0aDogZG9jUGF0aCxcclxuICAgICAgICBkZXB0aCxcclxuICAgICAgICBjb21taXQsXHJcbiAgICAgICAgcmVzb2x2ZTogZGVlcFJlc29sdmUuYmluZChudWxsLCBkb2NQYXRoKSxcclxuICAgICAgfSwgb3B0aW9ucyksXHJcbiAgICAgIHBhdGg6IHJlZi5wYXRoLFxyXG4gICAgfVxyXG4gIH0pXHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRDb2xsZWN0aW9uICh7XHJcbiAgdm0sXHJcbiAga2V5LFxyXG4gIGNvbGxlY3Rpb24sXHJcbiAgY29tbWl0LFxyXG4gIHJlc29sdmUsXHJcbiAgcmVqZWN0LFxyXG59LCBvcHRpb25zKSB7XHJcbiAgY29tbWl0KFZVRVhGSVJFX1NFVF9WQUxVRSwge1xyXG4gICAgcGF0aDoga2V5LFxyXG4gICAgdGFyZ2V0OiB2bSxcclxuICAgIGRhdGE6IFtdLFxyXG4gIH0sIGNvbW1pdE9wdGlvbnMpXHJcbiAgY29uc3QgdGFyZ2V0ID0gd2Fsa0dldCh2bSwga2V5KVxyXG4gIGNvbnN0IG9yaWdpbmFsUmVzb2x2ZSA9IHJlc29sdmVcclxuICBsZXQgaXNSZXNvbHZlZFxyXG5cclxuICAvLyBjb250YWluIHJlZiBzdWJzY3JpcHRpb25zIG9mIG9iamVjdHNcclxuICAvLyBhcnJheVN1YnMgaXMgYSBtaXJyb3Igb2YgYXJyYXlcclxuICBjb25zdCBhcnJheVN1YnMgPSBbXVxyXG5cclxuICBjb25zdCBjaGFuZ2UgPSB7XHJcbiAgICBhZGRlZDogKHsgbmV3SW5kZXgsIGRvYyB9KSA9PiB7XHJcbiAgICAgIGFycmF5U3Vicy5zcGxpY2UobmV3SW5kZXgsIDAsIE9iamVjdC5jcmVhdGUobnVsbCkpXHJcbiAgICAgIGNvbnN0IHN1YnMgPSBhcnJheVN1YnNbbmV3SW5kZXhdXHJcbiAgICAgIGNvbnN0IHNuYXBzaG90ID0gY3JlYXRlU25hcHNob3QoZG9jKVxyXG4gICAgICBjb25zdCBbZGF0YSwgcmVmc10gPSBleHRyYWN0UmVmcyhzbmFwc2hvdClcclxuICAgICAgY29tbWl0KFZVRVhGSVJFX0FSUkFZX0FERCwgeyB0YXJnZXQsIG5ld0luZGV4LCBkYXRhIH0sIGNvbW1pdE9wdGlvbnMpXHJcbiAgICAgIHN1YnNjcmliZVRvUmVmcyh7XHJcbiAgICAgICAgZGF0YSxcclxuICAgICAgICByZWZzLFxyXG4gICAgICAgIHN1YnMsXHJcbiAgICAgICAgdGFyZ2V0LFxyXG4gICAgICAgIHBhdGg6IG5ld0luZGV4LFxyXG4gICAgICAgIGRlcHRoOiAwLFxyXG4gICAgICAgIGNvbW1pdCxcclxuICAgICAgICByZXNvbHZlOiByZXNvbHZlLmJpbmQobnVsbCwgZG9jKSxcclxuICAgICAgfSwgb3B0aW9ucylcclxuICAgIH0sXHJcbiAgICBtb2RpZmllZDogKHsgb2xkSW5kZXgsIG5ld0luZGV4LCBkb2MgfSkgPT4ge1xyXG4gICAgICBjb25zdCBzdWJzID0gYXJyYXlTdWJzLnNwbGljZShvbGRJbmRleCwgMSlbMF1cclxuICAgICAgYXJyYXlTdWJzLnNwbGljZShuZXdJbmRleCwgMCwgc3VicylcclxuICAgICAgLy8gY29uc3Qgb2xkRGF0YSA9IGFycmF5LnNwbGljZShvbGRJbmRleCwgMSlbMF1cclxuICAgICAgY29uc3Qgb2xkRGF0YSA9IGNvbW1pdChWVUVYRklSRV9BUlJBWV9SRU1PVkUsIHsgdGFyZ2V0LCBvbGRJbmRleCB9LCBjb21taXRPcHRpb25zKVxyXG4gICAgICBjb25zdCBzbmFwc2hvdCA9IGNyZWF0ZVNuYXBzaG90KGRvYylcclxuICAgICAgY29uc3QgW2RhdGEsIHJlZnNdID0gZXh0cmFjdFJlZnMoc25hcHNob3QsIG9sZERhdGEpXHJcbiAgICAgIC8vIGFycmF5LnNwbGljZShuZXdJbmRleCwgMCwgZGF0YSlcclxuICAgICAgY29tbWl0KFZVRVhGSVJFX0FSUkFZX0FERCwgeyB0YXJnZXQsIG5ld0luZGV4LCBkYXRhIH0sIGNvbW1pdE9wdGlvbnMpXHJcbiAgICAgIHN1YnNjcmliZVRvUmVmcyh7XHJcbiAgICAgICAgZGF0YSxcclxuICAgICAgICByZWZzLFxyXG4gICAgICAgIHN1YnMsXHJcbiAgICAgICAgdGFyZ2V0LFxyXG4gICAgICAgIHBhdGg6IG5ld0luZGV4LFxyXG4gICAgICAgIGRlcHRoOiAwLFxyXG4gICAgICAgIGNvbW1pdCxcclxuICAgICAgICByZXNvbHZlLFxyXG4gICAgICB9LCBvcHRpb25zKVxyXG4gICAgfSxcclxuICAgIHJlbW92ZWQ6ICh7IG9sZEluZGV4IH0pID0+IHtcclxuICAgICAgLy8gYXJyYXkuc3BsaWNlKG9sZEluZGV4LCAxKVxyXG4gICAgICBjb21taXQoVlVFWEZJUkVfQVJSQVlfUkVNT1ZFLCB7IHRhcmdldCwgb2xkSW5kZXggfSwgY29tbWl0T3B0aW9ucylcclxuICAgICAgdW5zdWJzY3JpYmVBbGwoYXJyYXlTdWJzLnNwbGljZShvbGRJbmRleCwgMSlbMF0pXHJcbiAgICB9LFxyXG4gIH1cclxuXHJcbiAgY29uc3QgdW5iaW5kID0gY29sbGVjdGlvbi5vblNuYXBzaG90KHJlZiA9PiB7XHJcbiAgICAvLyBjb25zb2xlLmxvZygncGVuZGluZycsIG1ldGFkYXRhLmhhc1BlbmRpbmdXcml0ZXMpXHJcbiAgICAvLyBkb2NzLmZvckVhY2goZCA9PiBjb25zb2xlLmxvZygnZG9jJywgZCwgJ1xcbicsICdkYXRhJywgZC5kYXRhKCkpKVxyXG4gICAgLy8gTk9URSB0aGlzIHdpbGwgb25seSBiZSB0cmlnZ2VyZWQgb25jZSBhbmQgaXQgd2lsbCBiZSB3aXRoIGFsbCB0aGUgZG9jdW1lbnRzXHJcbiAgICAvLyBmcm9tIHRoZSBxdWVyeSBhcHBlYXJpbmcgYXMgYWRkZWRcclxuICAgIC8vIChodHRwczovL2ZpcmViYXNlLmdvb2dsZS5jb20vZG9jcy9maXJlc3RvcmUvcXVlcnktZGF0YS9saXN0ZW4jdmlld19jaGFuZ2VzX2JldHdlZW5fc25hcHNob3RzKVxyXG4gICAgY29uc3QgZG9jQ2hhbmdlcyA9IHR5cGVvZiByZWYuZG9jQ2hhbmdlcyA9PT0gJ2Z1bmN0aW9uJyA/IHJlZi5kb2NDaGFuZ2VzKCkgOiByZWYuZG9jQ2hhbmdlc1xyXG5cclxuICAgIGlmICghaXNSZXNvbHZlZCAmJiBkb2NDaGFuZ2VzLmxlbmd0aCkge1xyXG4gICAgICAvLyBpc1Jlc29sdmVkIGlzIG9ubHkgbWVhbnQgdG8gbWFrZSBzdXJlIHdlIGRvIHRoZSBjaGVjayBvbmx5IG9uY2VcclxuICAgICAgaXNSZXNvbHZlZCA9IHRydWVcclxuICAgICAgbGV0IGNvdW50ID0gMFxyXG4gICAgICBjb25zdCBleHBlY3RlZEl0ZW1zID0gZG9jQ2hhbmdlcy5sZW5ndGhcclxuICAgICAgY29uc3QgdmFsaWREb2NzID0gZG9jQ2hhbmdlcy5yZWR1Y2UoKGRpY3QsIHsgZG9jIH0pID0+IHtcclxuICAgICAgICBkaWN0W2RvYy5pZF0gPSBmYWxzZVxyXG4gICAgICAgIHJldHVybiBkaWN0XHJcbiAgICAgIH0sIE9iamVjdC5jcmVhdGUobnVsbCkpXHJcbiAgICAgIHJlc29sdmUgPSAoeyBpZCB9KSA9PiB7XHJcbiAgICAgICAgaWYgKGlkIGluIHZhbGlkRG9jcykge1xyXG4gICAgICAgICAgaWYgKCsrY291bnQgPj0gZXhwZWN0ZWRJdGVtcykge1xyXG4gICAgICAgICAgICBvcmlnaW5hbFJlc29sdmUodm1ba2V5XSlcclxuICAgICAgICAgICAgLy8gcmVzZXQgcmVzb2x2ZSB0byBub29wXHJcbiAgICAgICAgICAgIHJlc29sdmUgPSBfID0+IHt9XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgICBkb2NDaGFuZ2VzLmZvckVhY2goYyA9PiB7XHJcbiAgICAgIGNoYW5nZVtjLnR5cGVdKGMpXHJcbiAgICB9KVxyXG5cclxuICAgIC8vIHJlc29sdmVzIHdoZW4gYXJyYXkgaXMgZW1wdHlcclxuICAgIGlmICghZG9jQ2hhbmdlcy5sZW5ndGgpIHJlc29sdmUoKVxyXG4gIH0sIHJlamVjdClcclxuXHJcbiAgcmV0dXJuICgpID0+IHtcclxuICAgIHVuYmluZCgpXHJcbiAgICBhcnJheVN1YnMuZm9yRWFjaCh1bnN1YnNjcmliZUFsbClcclxuICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVwZGF0ZURhdGFGcm9tRG9jdW1lbnRTbmFwc2hvdCAoe1xyXG4gIHNuYXBzaG90LFxyXG4gIHRhcmdldCxcclxuICBwYXRoLFxyXG4gIHN1YnMsXHJcbiAgZGVwdGggPSAwLFxyXG4gIGNvbW1pdCxcclxuICByZXNvbHZlLFxyXG59LCBvcHRpb25zKSB7XHJcbiAgY29uc3QgW2RhdGEsIHJlZnNdID0gZXh0cmFjdFJlZnMoc25hcHNob3QsIHdhbGtHZXQodGFyZ2V0LCBwYXRoKSlcclxuICBjb21taXQoVlVFWEZJUkVfU0VUX1ZBTFVFLCB7XHJcbiAgICBwYXRoLFxyXG4gICAgdGFyZ2V0LFxyXG4gICAgZGF0YSxcclxuICB9LCBjb21taXRPcHRpb25zKVxyXG4gIHN1YnNjcmliZVRvUmVmcyh7XHJcbiAgICBkYXRhLFxyXG4gICAgc3VicyxcclxuICAgIHJlZnMsXHJcbiAgICB0YXJnZXQsXHJcbiAgICBwYXRoLFxyXG4gICAgZGVwdGgsXHJcbiAgICBjb21taXQsXHJcbiAgICByZXNvbHZlLFxyXG4gIH0sIG9wdGlvbnMpXHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN1YnNjcmliZVRvRG9jdW1lbnQgKHtcclxuICByZWYsXHJcbiAgdGFyZ2V0LFxyXG4gIHBhdGgsXHJcbiAgZGVwdGgsXHJcbiAgY29tbWl0LFxyXG4gIHJlc29sdmUsXHJcbn0sIG9wdGlvbnMpIHtcclxuICBjb25zdCBzdWJzID0gT2JqZWN0LmNyZWF0ZShudWxsKVxyXG4gIGNvbnN0IHVuYmluZCA9IHJlZi5vblNuYXBzaG90KGRvYyA9PiB7XHJcbiAgICBpZiAoZG9jLmV4aXN0cykge1xyXG4gICAgICB1cGRhdGVEYXRhRnJvbURvY3VtZW50U25hcHNob3Qoe1xyXG4gICAgICAgIHNuYXBzaG90OiBjcmVhdGVTbmFwc2hvdChkb2MpLFxyXG4gICAgICAgIHRhcmdldCxcclxuICAgICAgICBwYXRoLFxyXG4gICAgICAgIHN1YnMsXHJcbiAgICAgICAgZGVwdGgsXHJcbiAgICAgICAgY29tbWl0LFxyXG4gICAgICAgIHJlc29sdmUsXHJcbiAgICAgIH0sIG9wdGlvbnMpXHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBjb21taXQoVlVFWEZJUkVfU0VUX1ZBTFVFLCB7XHJcbiAgICAgICAgdGFyZ2V0LFxyXG4gICAgICAgIHBhdGgsXHJcbiAgICAgICAgZGF0YTogbnVsbCxcclxuICAgICAgfSwgY29tbWl0T3B0aW9ucylcclxuICAgICAgcmVzb2x2ZShwYXRoKVxyXG4gICAgfVxyXG4gIH0pXHJcblxyXG4gIHJldHVybiAoKSA9PiB7XHJcbiAgICB1bmJpbmQoKVxyXG4gICAgdW5zdWJzY3JpYmVBbGwoc3VicylcclxuICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmREb2N1bWVudCAoe1xyXG4gIHZtLFxyXG4gIGtleSxcclxuICBkb2N1bWVudCxcclxuICBjb21taXQsXHJcbiAgcmVzb2x2ZSxcclxuICByZWplY3QsXHJcbn0sIG9wdGlvbnMpIHtcclxuICAvLyBUT0RPIHdhcm5pbmcgY2hlY2sgaWYga2V5IGV4aXN0cz9cclxuICAvLyBjb25zdCBib3VuZFJlZnMgPSBPYmplY3QuY3JlYXRlKG51bGwpXHJcblxyXG4gIGNvbnN0IHN1YnMgPSBPYmplY3QuY3JlYXRlKG51bGwpXHJcbiAgLy8gYmluZCBoZXJlIHRoZSBmdW5jdGlvbiBzbyBpdCBjYW4gYmUgcmVzb2x2ZWQgYW55d2hlcmVcclxuICAvLyB0aGlzIGlzIHNwZWNpYWxseSB1c2VmdWwgZm9yIHJlZnNcclxuICAvLyBUT0RPIHVzZSB3YWxrR2V0P1xyXG4gIHJlc29sdmUgPSBjYWxsT25jZVdpdGhBcmcocmVzb2x2ZSwgKCkgPT4gdm1ba2V5XSlcclxuICBjb25zdCB1bmJpbmQgPSBkb2N1bWVudC5vblNuYXBzaG90KGRvYyA9PiB7XHJcbiAgICBpZiAoZG9jLmV4aXN0cykge1xyXG4gICAgICB1cGRhdGVEYXRhRnJvbURvY3VtZW50U25hcHNob3Qoe1xyXG4gICAgICAgIHNuYXBzaG90OiBjcmVhdGVTbmFwc2hvdChkb2MpLFxyXG4gICAgICAgIHRhcmdldDogdm0sXHJcbiAgICAgICAgcGF0aDoga2V5LFxyXG4gICAgICAgIHN1YnMsXHJcbiAgICAgICAgY29tbWl0LFxyXG4gICAgICAgIHJlc29sdmUsXHJcbiAgICAgIH0sIG9wdGlvbnMpXHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICByZXNvbHZlKClcclxuICAgIH1cclxuICB9LCByZWplY3QpXHJcblxyXG4gIHJldHVybiAoKSA9PiB7XHJcbiAgICB1bmJpbmQoKVxyXG4gICAgdW5zdWJzY3JpYmVBbGwoc3VicylcclxuICB9XHJcbn1cclxuXHJcbi8vIEZpcmViYXNlIGJpbmRpbmdcclxuY29uc3Qgc3Vic2NyaXB0aW9ucyA9IG5ldyBXZWFrTWFwKClcclxuXHJcbmZ1bmN0aW9uIGJpbmQgKHtcclxuICBzdGF0ZSxcclxuICBjb21taXQsXHJcbiAga2V5LFxyXG4gIHJlZixcclxufSwgb3B0aW9ucyA9IHsgbWF4UmVmRGVwdGg6IDIgfSkge1xyXG4gIC8vIFRPRE8gY2hlY2sgcmVmIGlzIHZhbGlkXHJcbiAgLy8gVE9ETyBjaGVjayBkZWZpbmVkIGluIHN0YXRlXHJcbiAgbGV0IHN1YiA9IHN1YnNjcmlwdGlvbnMuZ2V0KGNvbW1pdClcclxuICBpZiAoIXN1Yikge1xyXG4gICAgc3ViID0gT2JqZWN0LmNyZWF0ZShudWxsKVxyXG4gICAgc3Vic2NyaXB0aW9ucy5zZXQoY29tbWl0LCBzdWIpXHJcbiAgfVxyXG5cclxuICAvLyB1bmJpbmQgaWYgcmVmIGlzIGFscmVhZHkgYm91bmRcclxuICBpZiAoa2V5IGluIHN1Yikge1xyXG4gICAgdW5iaW5kKHsgY29tbWl0LCBrZXkgfSlcclxuICB9XHJcblxyXG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XHJcbiAgICBzdWJba2V5XSA9IHJlZi53aGVyZVxyXG4gICAgICA/IGJpbmRDb2xsZWN0aW9uKHtcclxuICAgICAgICB2bTogc3RhdGUsXHJcbiAgICAgICAga2V5LFxyXG4gICAgICAgIGNvbGxlY3Rpb246IHJlZixcclxuICAgICAgICBjb21taXQsXHJcbiAgICAgICAgcmVzb2x2ZSxcclxuICAgICAgICByZWplY3QsXHJcbiAgICAgIH0sIG9wdGlvbnMpXHJcbiAgICAgIDogYmluZERvY3VtZW50KHtcclxuICAgICAgICB2bTogc3RhdGUsXHJcbiAgICAgICAga2V5LFxyXG4gICAgICAgIGRvY3VtZW50OiByZWYsXHJcbiAgICAgICAgY29tbWl0LFxyXG4gICAgICAgIHJlc29sdmUsXHJcbiAgICAgICAgcmVqZWN0LFxyXG4gICAgICB9LCBvcHRpb25zKVxyXG4gIH0pXHJcbn1cclxuXHJcbmZ1bmN0aW9uIHVuYmluZCAoe1xyXG4gIGNvbW1pdCxcclxuICBrZXksXHJcbn0pIHtcclxuICBsZXQgc3ViID0gc3Vic2NyaXB0aW9ucy5nZXQoY29tbWl0KVxyXG4gIGlmICghc3ViKSByZXR1cm5cclxuICAvLyBUT0RPIGRldiBjaGVjayBiZWZvcmVcclxuICBzdWJba2V5XSgpXHJcbiAgZGVsZXRlIHN1YltrZXldXHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBmaXJlYmFzZUFjdGlvbiAoYWN0aW9uKSB7XHJcbiAgcmV0dXJuIGZ1bmN0aW9uIGZpcmViYXNlRW5oYW5jZWRBY3Rpb25GbiAoY29udGV4dCwgcGF5bG9hZCkge1xyXG4gICAgLy8gZ2V0IHRoZSBsb2NhbCBzdGF0ZSBhbmQgY29tbWl0LiBUaGVzZSBtYXkgYmUgYm91bmQgdG8gYSBtb2R1bGVcclxuICAgIGNvbnN0IHsgc3RhdGUsIGNvbW1pdCB9ID0gY29udGV4dFxyXG4gICAgY29udGV4dC5iaW5kRmlyZWJhc2VSZWYgPSAoa2V5LCByZWYsIG9wdGlvbnMgPSB7fSkgPT5cclxuICAgICAgYmluZCh7IHN0YXRlLCBjb21taXQsIGtleSwgcmVmIH0sIG9wdGlvbnMpXHJcbiAgICBjb250ZXh0LnVuYmluZEZpcmViYXNlUmVmID0gKGtleSkgPT5cclxuICAgICAgdW5iaW5kKHsgY29tbWl0LCBrZXkgfSlcclxuICAgIHJldHVybiBhY3Rpb24oY29udGV4dCwgcGF5bG9hZClcclxuICB9XHJcbn1cclxuIl19