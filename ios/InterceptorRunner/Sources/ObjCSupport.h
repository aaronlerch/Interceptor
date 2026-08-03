//
//  ObjCSupport.h — Obj-C helpers the Swift runner can't express natively.
//
//  XCUITest APIs (snapshot/activate/tap on a misbehaving app) raise Obj-C
//  NSExceptions, which crash a pure-Swift test. ICRunCatching wraps a block in
//  @try/@catch so the runner turns a failed verb into an error frame instead of
//  tearing down the whole XCUITest session.
//
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Run `block` inside @try/@catch. Returns nil on success, or an NSError wrapping
/// the raised NSException (name + reason) on failure.
NSError * _Nullable ICRunCatching(void (^block)(void));

/// Bundle id of the current FOREGROUND app via the private XCTest accessibility
/// client (so `tree`/`find` work without an explicit `app activate`). nil if it
/// can't be determined (caller falls back to SpringBoard).
NSString * _Nullable ICActiveApplicationBundleID(void);

/// Diagnostic: describe the active-application elements (class + accessors) so the
/// right bundle-id accessor can be confirmed on-device.
NSString * _Nullable ICActiveApplicationDebug(void);

NS_ASSUME_NONNULL_END
